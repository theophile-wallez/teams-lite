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
// **And it captures SILENCE, not Chrome's tone.** The fake device's default is a loud
// repeating beep, and this meeting has real people in it — the user asked for it to stop
// after the third run, which is a fair thing to ask of a driver that joins a room they are
// sitting in. `--tone` brings it back for the one question silence cannot answer: whether
// the audio path carries anything at all (see {@link fakeAudioArgs}).
//
// Usage:
//
//   cd web && bun run join-live            # join, watch, hang up, print the timeline
//   cd web && bun run join-live -- --from-chat  # the same meeting, from its own chat header
//   cd web && bun run join-live -- --local # the same meeting through this machine's front
//   cd web && bun run join-live -- --hold 45   # stay 45s before hanging up
//   cd web && bun run join-live -- --tone  # capture Chrome's beep instead of silence

import { chromium, type Browser, type Page } from "playwright-core";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { findChromium, openCalendarView } from "./preview";
import { LOCAL_ORIGIN, TAILNET_ORIGIN } from "./sandbox-live";

/**
 * The one meeting this script may ever join: the user's own, authorized out loud for
 * exactly this test. Its CODE, because that is the part every spelling of the link
 * shares — the short `/meet/{code}` one in the invitation and the long
 * `/l/meetup-join/{thread}` one Graph hands the app both carry it.
 *
 * Never parameterise this, and never widen it to "the next meeting in the calendar".
 */
export const AUTHORIZED_MEETING_CODE = "380284954783239";

/** The thread that code resolves to on this tenant, for the second half of the proof. */
export const AUTHORIZED_MEETING_THREAD =
  "19:meeting_OTY2MTc4ODQtMWQ5YS00NGY3LThiZjEtZThiOGI0Zjc4N2Ez@thread.v2";

/**
 * The day it sits on — 2026-08-05, TODAY, which is the easy case: the calendar opens on
 * today and the first agenda window holds it.
 *
 * The search below still walks backwards, because the meeting authorized before this one
 * was in the PAST and a past meeting stays joinable — its thread outlives its slot in the
 * calendar, which is what lets this be tested without booking anything.
 */
export const AUTHORIZED_MEETING_DAY = "2026-08-05";

/**
 * What a link to that meeting is RECOGNISED by, in either spelling Teams writes one.
 *
 * The short `/meet/{code}` link in the invitation carries the code; the long
 * `/l/meetup-join/{thread}` link Graph hands the app carries the thread and NOT the code
 * — which is the shape the button really has, so a check on the code alone never matched.
 * The thread's own middle is used rather than the whole id, because the button's url is
 * percent-encoded (`19%3ameeting_…%40thread.v2`).
 */
const MEETING_MARKERS = [
  AUTHORIZED_MEETING_CODE,
  "meeting_OTY2MTc4ODQtMWQ5YS00NGY3LThiZjEtZThiOGI0Zjc4N2Ez",
];

/** Whether a join url names the pinned meeting. The ONE test both halves of this file use. */
function namesPinnedMeeting(link: string | null): boolean {
  return !!link && MEETING_MARKERS.some((marker) => link.includes(marker));
}

/**
 * How many agenda windows to look back through. The agenda spans 14 days and its
 * `previous` steps by the same, so two windows cover a month — enough to reach a meeting
 * from last week without ever wandering far enough to find a different one.
 */
const AGENDA_WINDOWS_BACK = 3;

const APP_READY_TIMEOUT_MS = 60_000;
const JOIN_BUTTON_TIMEOUT_MS = 30_000;
/** How long to watch a joined call before hanging up, unless `--hold` says otherwise. */
const DEFAULT_HOLD_SECONDS = 25;

/** How long the silent capture file lasts. Chrome loops it, so this only has to be long
 *  enough that the loop point is not itself a click. */
const SILENCE_SECONDS = 10;

/**
 * What to hand Chrome for its fake microphone.
 *
 * Silence by default. The fake device's own signal is a repeating beep at a healthy volume,
 * and every run of this script puts it into a real meeting with real people — so the default
 * has to be the one that costs them nothing. The offer is unchanged either way: same real
 * fingerprint, same real candidates, same SDP, which is what this driver exists to test.
 *
 * `--tone` is for the one thing silence cannot prove. Opus sends comfort noise for a silent
 * track, so `packetsSent` stays low and "the media path carries audio" is no longer visible
 * in `getStats` — that is what the beep was for, and it is still there when that is the
 * question being asked.
 */
function fakeAudioArgs(tone: boolean): string[] {
  if (tone) return [];
  const path = joinPath(tmpdir(), `teams-lite-silence-${SILENCE_SECONDS}s.wav`);
  writeFileSync(path, silentWav(SILENCE_SECONDS));
  return [`--use-file-for-fake-audio-capture=${path}`];
}

/** A WAV of nothing: 16-bit mono at 48 kHz, which is what Opus wants anyway. */
function silentWav(seconds: number): Buffer {
  const rate = 48_000;
  const samples = rate * seconds;
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data); // the header, then zeros — silence needs no fill
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16); // the size of the format chunk
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // one channel
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28); // bytes per second
  buffer.writeUInt16LE(2, 32); // bytes per frame
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

/** One reading of the live call, as the app itself renders it. */
export type CallBarState = {
  /** `dialing` | `connecting` | `connected` | `ended`, from the surface's own attribute. */
  phase: string | null;
  /** What it says under the title — "Joining…", "Waiting to be let in…", a timer. */
  detail: string;
  /** The notice that is left behind when a call ends, when there is one. */
  notice: string;
};

export type JoinLiveSession = {
  meeting: string;
  url: string;
  /** Read what the app says about the call now. */
  callBar: () => Promise<CallBarState>;
  /** Wait until it reaches one of `phases`, or the timeout expires. */
  waitForPhase: (phases: string[], timeoutMs?: number) => Promise<CallBarState>;
  /** Every distinct state seen since the click, in order. */
  timeline: () => CallBarState[];
  /** Screenshot the page or one element. */
  shot: (path: string, selector?: string) => Promise<void>;
  /** What the MEDIA is actually doing — the half no surface can show. */
  mediaStats: () => Promise<MediaStats | null>;
  /** What the SERVICE said, digested — the half neither the page nor `getStats` shows. */
  signals: () => Promise<SignalDigest>;
};

/**
 * What the calling service told this machine, reduced to the facts a protocol question
 * needs — and to nothing else.
 *
 * It exists for the video work (NATIVE-CALLING.md § 10.7): the roster is where a
 * publishing stream's media source id comes from, and the link set is what says whether a
 * source can be subscribed to over signaling at all. Both arrive on frames the page
 * already receives (`call_signal`, forwarded whole) and neither is drawn anywhere, so
 * without this the only way to read them was to add a log line to the always-on service.
 *
 * **It reports SHAPES, never keys.** A link's url carries a session id, so only its NAME
 * travels; a person is named because the call bar names them anyway.
 */
export type SignalDigest = {
  /** Every link name the join answer carried, sorted. Measurement 1 of § 10.7. */
  joinLinks: string[];
  /** The link names that would carry a source request, if the answer named any. */
  sourceRequestLinks: string[];
  /** Which callback paths the service actually POSTed to, and how often. */
  framePaths: Record<string, number>;
  /** One entry per person the roster published a stream for. Measurement 3 of § 10.7. */
  publishers: Array<{
    name: string;
    state: string;
    /** `endpoints.endpointDetails[].mediaStreams[]`, verbatim — the `sourceId` in here is
     *  the msi a subscription is addressed by. */
    mediaStreams: unknown[];
    /** Whether the roster gave them a `contentSharing` object (they are sharing). */
    sharing: boolean;
  }>;
  /** The keys a roster participant really carries, so this file's reading of the shape can
   *  be checked against the tenant rather than against the client's bundle. */
  participantKeys: string[];
  /** How many `call_signal` frames were seen at all. Zero means the sniffer missed. */
  frames: number;
  /** The link names each callback path's own frame published. The media controller's two
   *  links arrive HERE rather than in the join answer, which is why both are read. */
  frameLinks: Record<string, string[]>;
  /** The media sections of every SDP the service sent, per callback path — kind, profile,
   *  mid, label and direction, and nothing else. What it is willing to negotiate. */
  mediaLines: Record<string, string[]>;
  /** ONE roster participant as a key tree — every key, every type, no value except the few
   *  that are the measurement itself. It exists because this shape was guessed wrong twice:
   *  a name is not `displayName` at the top, and the streams are not where the client's own
   *  bundle reads them. A skeleton cannot be guessed wrong. */
  participantShape: string[];
  /** `participantCounts`, verbatim — numbers, so it says how many people were really there
   *  rather than how many this reading managed to find. */
  participantCounts: unknown;
};

/** The only values a skeleton prints. Each one IS the measurement — a stream's kind and its
 *  media source id — and none of them names a person. */
const SKELETON_VALUES = new Set([
  "type",
  "sourceId",
  "state",
  "mediaType",
  "label",
  "isSharing",
  "capabilities",
]);

/**
 * A value as a key tree: `key: type`, one line per key, arrays as their length and their
 * first element's shape.
 *
 * Never a value, except {@link SKELETON_VALUES}. So this can be printed from a real
 * meeting with real colleagues in it without printing anything about them.
 */
function skeleton(value: unknown, depth = 0, max = 5): string[] {
  const pad = "  ".repeat(depth);
  if (depth > max) return [`${pad}…`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[] (empty)`];
    return [`${pad}[${value.length} ×`, ...skeleton(value[0], depth + 1, max), `${pad}]`];
  }
  if (!value || typeof value !== "object") return [`${pad}${typeof value}`];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SKELETON_VALUES.has(key) && (typeof child !== "object" || child === null)) {
      out.push(`${pad}${key} = ${JSON.stringify(child)}`);
      continue;
    }
    if (child === null || typeof child !== "object") {
      out.push(`${pad}${key}: ${child === null ? "null" : typeof child}`);
      continue;
    }
    out.push(`${pad}${key}:`);
    out.push(...skeleton(child, depth + 1, max));
  }
  return out;
}

/**
 * The peer connection's own account of the call.
 *
 * "Connected" on the bar means the signaling completed and the answer was applied. It does
 * NOT mean audio is flowing: DTLS can still fail, ICE can still find no path, and the bar
 * would look identical. These numbers are the difference, and they come from
 * `RTCPeerConnection.getStats()` rather than from anything this app renders.
 */
export type MediaStats = {
  connectionState: string;
  iceConnectionState: string;
  /** The transport actually chosen, as `host|srflx|relay → …`, when ICE picked one. */
  candidatePair: string | null;
  /** Bytes we have SENT. Non-zero proves our own audio is leaving the machine. */
  bytesSent: number;
  /** Bytes we have RECEIVED. Zero in an empty meeting is expected — nobody is talking. */
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
};

/**
 * Join the pinned meeting in the live app, run `body`, then hang up and close.
 *
 * Throws — before the click — unless the button on screen names the pinned meeting.
 */
export async function withJoinLive<T>(
  body: (session: JoinLiveSession) => Promise<T>,
  opts: { front?: "tailnet" | "local"; tone?: boolean; from?: "calendar" | "chat" } = {},
): Promise<T> {
  const origin = opts.front === "local" ? LOCAL_ORIGIN : TAILNET_ORIGIN;
  const url = origin;
  await assertFrontIsServing(origin);

  console.log(
    `\n  LIVE ACCOUNT — pinned to meeting ${AUTHORIZED_MEETING_CODE}\n  ${url}\n` +
      `  microphone: fake, capturing ${opts.tone === true ? "Chrome's TONE" : "silence"}\n`,
  );

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
        // Silence, unless the caller asked for the tone. See `fakeAudioArgs`.
        ...fakeAudioArgs(opts.tone === true),
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      permissions: ["microphone"],
      ignoreHTTPSErrors: true,
    });
    // Keep a handle on the app's own peer connection, from BEFORE its code runs.
    //
    // The alternative was a `data-media-state` attribute on the call bar, i.e. production
    // code carrying a diagnostic. This is instrumentation, so it belongs to the driver:
    // nothing the user runs is changed by it, and it cannot drift from what the app does
    // because it wraps the browser's own constructor.
    await context.addInitScript({
      content: `(() => {
        const Native = window.RTCPeerConnection;
        if (!Native) return;
        const Wrapped = function (...args) {
          const pc = new Native(...args);
          window.__tlPc = pc;
          return pc;
        };
        Wrapped.prototype = Native.prototype;
        window.RTCPeerConnection = Wrapped;
      })()`,
    });
    // And a handle on what the BACKEND says, for the same reason and by the same means.
    //
    // `call_signal` carries every raw calling frame to every client, and the `call_join`
    // reply names every link the answer held — so both are already on this socket and
    // neither is rendered. Wrapping the socket keeps the reading in the driver, where a
    // diagnostic belongs: the app the user runs is unchanged, and this cannot drift from
    // what the app receives because it IS what the app receives.
    await context.addInitScript({
      content: `(() => {
        const Native = window.WebSocket;
        if (!Native) return;
        window.__tlSignals = [];
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", (event) => {
              if (typeof event.data !== "string") return;
              if (!/"call_signal"|"links"/.test(event.data)) return;
              // Bounded: a long meeting sends a roster frame every few seconds, and an
              // unbounded array in a page under test is its own kind of failure.
              if (window.__tlSignals.length > 600) window.__tlSignals.shift();
              window.__tlSignals.push(event.data);
            });
          }
        };
      })()`,
    });
    page = await context.newPage();
    // The page's own voice. Everything that can go wrong in the MEDIA half is reported
    // here and nowhere else: the backend sees a clean join, and the browser sees
    // `setRemoteDescription` refuse an answer. Without this the whole failure is one
    // second of "Joining…" followed by a hangup nobody ordered.
    page.on("console", (message) => {
      const text = message.text();
      if (!/call|sdp|media|microphone|rtc/i.test(text)) return;
      console.log(`  [page ${message.type()}] ${oneLine(text).slice(0, 400)}`);
    });
    page.on("pageerror", (error) => {
      console.log(`  [page error] ${oneLine(String(error.message)).slice(0, 400)}`);
    });
    const seen: CallBarState[] = [];
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The two ways into the same meeting, and each proves the same target its own way:
    // the CALENDAR event's button states the join link, the CHAT header's states the
    // thread. Both are read off the page immediately before the click.
    const button =
      opts.from === "chat"
        ? await findPinnedJoinButtonInChat(page, origin)
        : await findPinnedJoinButton(page);
    await assertPinnedMeeting(button, page);
    console.log(
      `  joining ${AUTHORIZED_MEETING_CODE} — the pinned meeting, from ` +
        `${opts.from === "chat" ? "its own chat" : "the calendar"}`,
    );
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
      mediaStats: () => readMediaStats(page as Page),
      signals: () => readSignals(page as Page),
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
 * Every event on screen, with what its own panel offers — the diagnostic half of this
 * file, for when the pinned meeting is not where it was expected.
 *
 * It reads and never clicks Join, so it is safe to run at any time.
 */
async function listEvents(page: Page): Promise<string[]> {
  await openCalendar(page);
  const events = page.locator('[data-testid="calendar-event"]');
  const out: string[] = [];
  for (let i = 0; i < (await events.count()); i += 1) {
    const event = events.nth(i);
    const title = (await event.getAttribute("title")) ?? (await event.innerText());
    await event.click().catch(() => {});
    const join = page.locator('[data-testid="meeting-join-here"]').first();
    const link = await join.getAttribute("data-join-url", { timeout: 1_500 }).catch(() => null);
    const disabled = await join.isDisabled({ timeout: 500 }).catch(() => null);
    out.push(
      `${oneLine(title).slice(0, 70)}  join=${
        link === null ? "none" : namesPinnedMeeting(link) ? "PINNED" : "other"
      }${disabled === true ? " (disabled)" : ""}`,
    );
    await page.keyboard.press("Escape").catch(() => {});
  }
  return out;
}

/** Open the calendar tab and put it in the agenda view. */
async function openCalendar(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="tab-calendar"]', { timeout: APP_READY_TIMEOUT_MS });
  await page.locator('[data-testid="tab-calendar"]').click();
  await page.waitForSelector('[data-testid="calendar-pane"]', { timeout: APP_READY_TIMEOUT_MS });
  // The AGENDA view, because it is a list: in the day grid two meetings at the same hour
  // overlap, and each one intercepts the other's click — so a script walking the events
  // there clicks whichever is drawn on top, which is the opposite of proving its target.
  await openCalendarView(page, "agenda");
}

/**
 * The Join button of the pinned meeting, found by opening events until one of them
 * offers a join for that code.
 *
 * It walks the day's events rather than trusting a position, and it never clicks a
 * button whose link it has not read.
 */
async function findPinnedJoinButton(page: Page) {
  await openCalendar(page);
  for (let window = 0; window <= AGENDA_WINDOWS_BACK; window += 1) {
    const found = await findInThisWindow(page);
    if (found) return found;
    if (window === AGENDA_WINDOWS_BACK) break;
    // Back one agenda window. The meeting is in the past, and the calendar opens on
    // today (see AUTHORIZED_MEETING_DAY).
    await page.locator('[data-testid="calendar-prev"]').click();
    await page.waitForTimeout(600);
  }
  throw new Error(
    `No event in the last ${AGENDA_WINDOWS_BACK + 1} agenda windows offers a join for ` +
      `meeting ${AUTHORIZED_MEETING_CODE} (${AUTHORIZED_MEETING_DAY}), which is the only ` +
      `one this script may join. Either it is further back than that, or calling is off ` +
      `in Settings — the button is disabled then, and this script will not click a ` +
      `disabled one. It joins that meeting and no other; do not point it elsewhere.`,
  );
}

/** Look through the events of the window on screen for the pinned meeting's Join button. */
async function findInThisWindow(page: Page) {
  const events = page.locator('[data-testid="calendar-event"]');
  const count = await events.count();
  for (let i = 0; i < count; i += 1) {
    await events.nth(i).click().catch(() => {});
    const join = page.locator('[data-testid="meeting-join-here"]').first();
    const link = await join.getAttribute("data-join-url", { timeout: 1_500 }).catch(() => null);
    if (namesPinnedMeeting(link)) return join;
    await page.keyboard.press("Escape").catch(() => {});
  }
  return null;
}

/**
 * The Join button in the pinned meeting's own CHAT — the other half of the feature, and
 * the only way to exercise it live.
 *
 * A meeting-backed thread is a join ADDRESS on its own (`MeetingJoin::from_thread_id`), so
 * this path never involves a link at all: the calendar is not opened, and nothing is
 * searched for. The conversation is opened by its own id — the pinned thread, a constant in
 * this file — exactly as `sandbox-live.ts` opens the sandbox chat, because clicking through
 * the sidebar of a live app cannot prove which thread was opened.
 *
 * Two proofs before the click, both out of the app's own state: the composer says which
 * conversation is open, and the button says which meeting it joins.
 */
async function findPinnedJoinButtonInChat(page: Page, origin: string) {
  await page.goto(`${origin}/c/${encodeURIComponent(AUTHORIZED_MEETING_THREAD)}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.locator('[data-testid="composer-shell"]');
  await composer.waitFor({ timeout: APP_READY_TIMEOUT_MS });
  const open = await composer.getAttribute("data-conversation-id");
  if (open !== AUTHORIZED_MEETING_THREAD) {
    throw new Error(
      `REFUSING TO JOIN: the open conversation is ${open ?? "unknown"}, not the pinned ` +
        `meeting's thread ${AUTHORIZED_MEETING_THREAD}.\n  now at: ${page.url()}`,
    );
  }
  return page.locator('[data-testid="meeting-join-here"]').first();
}

/**
 * The gate. Reads the button's OWN address — the join link, or the meeting thread — and
 * throws unless it names the pinned meeting.
 *
 * Re-read immediately before the click for the same reason `sandbox-live.ts` re-reads
 * its conversation id: "it was the right event a moment ago" is not proof that the
 * panel still shows it.
 */
async function assertPinnedMeeting(
  button: ReturnType<Page["locator"]>,
  page: Page,
): Promise<void> {
  await button.waitFor({ timeout: JOIN_BUTTON_TIMEOUT_MS });
  const link = await button.getAttribute("data-join-url");
  const thread = await button.getAttribute("data-meeting-thread");
  // A thread is compared WHOLE, and to one constant: it is an exact id, so there is no
  // reason to match a fragment of it the way a percent-encoded url needs.
  if (thread !== null && thread === AUTHORIZED_MEETING_THREAD) return;
  if (namesPinnedMeeting(link)) return;
  const shown =
    link === null && thread === null
      ? "unknown: the button states neither `data-join-url` nor `data-meeting-thread`. If " +
        "the app otherwise works, the service is probably serving a bundle staged before " +
        "that attribute existed — check `bin/teams-lite-service.sh status` and re-stage " +
        "with `update`"
      : `"${thread ?? link}"`;
  throw new Error(
    `REFUSING TO JOIN: this app is talking to the real Teams account, and the button on ` +
      `screen joins ${shown}, not the pinned meeting ${AUTHORIZED_MEETING_CODE}.\n` +
      `  now at: ${page.url()}\n` +
      `A click here would put the user in somebody else's meeting, where everybody ` +
      `present would see them arrive. Do not work around this.`,
  );
}

/**
 * Read the live call as the app renders it.
 *
 * TWO surfaces carry the state, and this reads whichever is up: the PAGE a live call takes
 * over (`call-stage`, which is every phase of a join) and the card a RINGING call is offered
 * on (`call-bar`, which a join never reaches). Both state the phase in the same attribute,
 * so this asks for the stage first and falls back — a driver that knew only one of them
 * would report `phase: null` through a whole working join.
 */
async function readCallBar(page: Page): Promise<CallBarState> {
  const stage = page.locator('[data-testid="call-stage"]').first();
  const bar = (await stage.count()) ? stage : page.locator('[data-testid="call-bar"]').first();
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

/** Poll until the call reaches one of `phases`, recording every change on the way. */
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

/** Ask the peer connection what the media is really doing. */
async function readMediaStats(page: Page): Promise<MediaStats | null> {
  // Source text rather than a closure, for the same reason as the init script above: this
  // file is typed for node, and `RTCPeerConnection` does not exist here.
  return page.evaluate(`(async () => {
    const pc = window.__tlPc;
    if (!pc) return null;
    const stats = await pc.getStats();
    let bytesSent = 0, bytesReceived = 0, packetsSent = 0, packetsReceived = 0;
    let candidatePair = null;
    const candidates = new Map();
    stats.forEach((r) => {
      if (r.type === "local-candidate" || r.type === "remote-candidate") {
        candidates.set(r.id, { type: r.candidateType, protocol: r.protocol });
      }
    });
    stats.forEach((r) => {
      if (r.type === "outbound-rtp") {
        bytesSent += r.bytesSent || 0;
        packetsSent += r.packetsSent || 0;
      }
      if (r.type === "inbound-rtp") {
        bytesReceived += r.bytesReceived || 0;
        packetsReceived += r.packetsReceived || 0;
      }
      if (r.type === "candidate-pair" && r.state === "succeeded") {
        const local = candidates.get(r.localCandidateId) || {};
        const remote = candidates.get(r.remoteCandidateId) || {};
        candidatePair =
          (local.type || "?") + "/" + (local.protocol || "?") + " -> " +
          (remote.type || "?") + "/" + (remote.protocol || "?");
      }
    });
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      candidatePair, bytesSent, bytesReceived, packetsSent, packetsReceived,
    };
  })()`) as Promise<MediaStats | null>;
}

/** The link names that would carry a source request — the two spellings the web client
 *  sends, one per config flag (NATIVE-CALLING.md § 10.2). */
const SOURCE_REQUEST_LINKS = ["controlVideoStreaming", "applyChannelParameters"];

/**
 * Digest what the service said. See {@link SignalDigest} for why this exists.
 *
 * The frames are parsed HERE rather than in the page: the page hands back the raw strings
 * it received, so a reading that turns out to be wrong can be corrected without joining
 * the meeting again.
 */
async function readSignals(page: Page): Promise<SignalDigest> {
  const raw = (await page.evaluate("window.__tlSignals || []")) as string[];
  const digest: SignalDigest = {
    joinLinks: [],
    sourceRequestLinks: [],
    framePaths: {},
    publishers: [],
    participantKeys: [],
    frames: 0,
    frameLinks: {},
    mediaLines: {},
    participantShape: [],
    participantCounts: null,
  };
  const publishers = new Map<string, SignalDigest["publishers"][number]>();
  const participantKeys = new Set<string>();
  const joinLinks = new Set<string>();
  const frameLinks = new Map<string, Set<string>>();

  for (const text of raw) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The `call_join` reply. The backend answers `{call_id, links:[…names]}` — never a
    // url — so this is measurement 1 with nothing to redact.
    const result = (message.result ?? message.params) as Record<string, unknown> | undefined;
    const links = result?.links;
    if (Array.isArray(links) && links.every((name) => typeof name === "string")) {
      for (const name of links as string[]) joinLinks.add(name);
    }
    if (message.method !== "call_signal" && message.event !== "call_signal") continue;
    const params = (message.params ?? message.data) as Record<string, unknown> | undefined;
    if (!params) continue;
    digest.frames += 1;
    // WHICH callback the service posted to, as its trailing path — the url's own tail,
    // never the surl in front of it, which is a session key.
    const url = typeof params.url === "string" ? params.url : "";
    const path = url.match(/\/(?:call|conversation)\/[A-Za-z]+\/?$/)?.[0] ?? "other";
    digest.framePaths[path] = (digest.framePaths[path] ?? 0) + 1;
    // The links a FRAME publishes, which is where the media controller's own two arrive:
    // the client reads `links.controlVideoStreaming` off a frame rather than off the join
    // answer (`saveMediaControllerLinksIfAny`), so the answer's list is not the whole set.
    const named = frameLinks.get(path) ?? new Set<string>();
    for (const name of linkNamesIn(params.body)) named.add(name);
    if (named.size > 0) frameLinks.set(path, named);
    // Every SDP the frame carries, as m-lines only. This is what says which sections the
    // service is willing to negotiate — measurement 2 read off ITS offer rather than
    // guessed at in ours.
    for (const blob of sdpBlobsIn(params.body)) {
      digest.mediaLines[path] = summariseSdp(blob);
    }
    if (path.includes("rosterUpdate")) {
      const counts = (params.body as Record<string, unknown> | null)?.participantCounts;
      if (counts) digest.participantCounts = counts;
    }
    for (const person of rosterParticipants(params.body, path)) {
      for (const key of Object.keys(person)) participantKeys.add(key);
      const streams = publishedStreams(person);
      const sharing = !!person.contentSharing;
      const name = personName(person);
      // The RICHEST participant seen wins the skeleton: a roster frame for somebody who
      // just muted carries less than one for somebody publishing two streams, and the
      // fuller tree is the one that answers the question.
      const tree = skeleton(person);
      if (tree.length > digest.participantShape.length) digest.participantShape = tree;
      // Every participant is kept, streams or not: "the roster names three people and
      // publishes nothing" and "the roster was not read at all" are different answers, and
      // reporting the second as the first is how this reading was wrong the first time.
      publishers.set(`${name}|${JSON.stringify(streams)}|${sharing}`, {
        name,
        state: typeof person.state === "string" ? person.state : "",
        mediaStreams: streams,
        sharing,
      });
    }
  }
  digest.joinLinks = [...joinLinks].sort();
  const everyLink = new Set([...joinLinks, ...[...frameLinks.values()].flatMap((s) => [...s])]);
  digest.sourceRequestLinks = SOURCE_REQUEST_LINKS.filter((name) => everyLink.has(name));
  digest.publishers = [...publishers.values()];
  digest.participantKeys = [...participantKeys].sort();
  digest.frameLinks = Object.fromEntries(
    [...frameLinks].map(([path, names]) => [path, [...names].sort()]),
  );
  return digest;
}

/**
 * Every key of every `links` OBJECT at any depth — names only, never a url.
 *
 * A frame's links are a nested object rather than the flat array the RPC answers with, and
 * `Links::collect` in the backend walks them the same way for the same reason: the service
 * puts them wherever it likes.
 */
function linkNamesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) linkNamesIn(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "links" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const name of Object.keys(child as Record<string, unknown>)) out.add(name);
    }
    linkNamesIn(child, out);
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

/**
 * One line per media section: its kind, its transport profile, its direction and its
 * label. The whole point of this section of the file, and it prints no key, no candidate
 * and no fingerprint — an m-line and four attributes.
 */
function summariseSdp(sdp: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      const [kind, port, profile] = line.slice(2).split(" ");
      current = [`${kind} port=${port} ${profile}`];
      out.push(current.join(" "));
      continue;
    }
    if (!current) continue;
    const at = out.length - 1;
    for (const prefix of ["a=mid:", "a=label:", "a=x-ssrc-range:"]) {
      if (line.startsWith(prefix)) out[at] += ` ${line.slice(2)}`;
    }
    if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) out[at] += ` ${line.slice(2)}`;
  }
  return out;
}

/**
 * Every participant a roster frame names — and the shape here is the whole finding.
 *
 * On this tenant a `rosterUpdate` frame's BODY *is* the roster:
 * `{type:"Delta", sequenceNumber, participantCounts, participants}`, with no `rosterUpdate`
 * key wrapping it — the URL it was posted to is what names it. And `participants` is an
 * OBJECT keyed by mri rather than the array the client's own types suggest. So both
 * readings are tried, the outer one first, because a wrapped frame is what the backend's
 * `roster_in_frame` was written against and one of the two has to be wrong.
 */
function rosterParticipants(body: unknown, path: string): Array<Record<string, unknown>> {
  const outer = body as Record<string, any> | null;
  const roster =
    outer?.rosterUpdate ??
    outer?._decoded?.rosterUpdate ??
    // The body itself, when the path already said what it is.
    (path.includes("rosterUpdate") ? outer : null);
  const participants = roster?.participants;
  if (Array.isArray(participants)) return participants as Array<Record<string, unknown>>;
  if (participants && typeof participants === "object") {
    return Object.entries(participants as Record<string, unknown>).map(([mri, person]) => ({
      id: mri,
      ...(person && typeof person === "object" ? (person as Record<string, unknown>) : {}),
    }));
  }
  return [];
}

/** The streams one participant publishes: `endpoints.endpointDetails[].mediaStreams[]`,
 *  each `{type, sourceId}` — and any `mediaStreams` at any depth, because that nesting is
 *  the client's own reading and this roster is one level deeper than it. */
function publishedStreams(person: Record<string, unknown>): unknown[] {
  const named = (person.endpoints as Record<string, any> | undefined)?.endpointDetails;
  if (Array.isArray(named)) {
    const found = named.flatMap((endpoint: Record<string, unknown>) =>
      Array.isArray(endpoint?.mediaStreams) ? (endpoint.mediaStreams as unknown[]) : [],
    );
    if (found.length > 0) return found;
  }
  return everyMediaStream(person);
}

/** Any `mediaStreams` array at any depth. The fallback that stops one wrong path from
 *  reading a roster full of streams as an empty one. */
function everyMediaStream(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) everyMediaStream(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "mediaStreams" && Array.isArray(child)) out.push(...child);
    else everyMediaStream(child, out);
  }
  return out;
}

/** A participant's name, wherever this roster keeps it. `displayName` at the top is the
 *  client's own reading; here it sits under `details`. */
function personName(person: Record<string, unknown>): string {
  const details = person.details as Record<string, unknown> | undefined;
  for (const candidate of [person.displayName, details?.displayName, details?.name]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return "(unnamed)";
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
  const tone = argv.includes("--tone");
  // WHERE the join is started from. The same meeting either way — the flag chooses which
  // surface's button is proved and pressed, never which meeting.
  const from = argv.includes("--from-chat") ? "chat" : "calendar";
  const holdAt = argv.indexOf("--hold");
  const hold = holdAt >= 0 ? Number(argv[holdAt + 1]) : DEFAULT_HOLD_SECONDS;

  await withJoinLive(
    async ({ waitForPhase: wait, timeline, mediaStats: stats, signals }) => {
      // First: does it get past "joining" at all? That is the acceptance and its answer.
      const state = await wait(["connected", "ended"], 45_000);
      if (state.phase === "connected") {
        console.log(`\n  CONNECTED. Holding ${hold}s to see whether it stays up.`);
        await wait(["ended"], hold * 1_000);
      }
      // What the MEDIA did, which is the half the bar cannot show. Bytes SENT prove our
      // own audio left the machine; bytes RECEIVED are expected to be zero in an empty
      // meeting, because nobody is talking.
      const media = await stats();
      if (media) {
        console.log(
          `\n  media: ${media.connectionState}/${media.iceConnectionState}` +
            ` via ${media.candidatePair ?? "no pair"}\n` +
            `  sent ${media.bytesSent}B in ${media.packetsSent} packets,` +
            ` received ${media.bytesReceived}B in ${media.packetsReceived}`,
        );
      }
      // And what the SERVICE said — the half that decides whether video is reachable at
      // all (NATIVE-CALLING.md § 10.7). Printed on every run, because it costs one
      // `evaluate` and the frames are gone once the page closes.
      const signal = await signals();
      console.log(`\n  signals: ${signal.frames} frames, ${signal.joinLinks.length} links`);
      console.log(
        `  source-request links: ${
          signal.sourceRequestLinks.length ? signal.sourceRequestLinks.join(", ") : "NONE"
        }`,
      );
      console.log(`  frames by path: ${JSON.stringify(signal.framePaths)}`);
      console.log(`  participant counts: ${JSON.stringify(signal.participantCounts)}`);
      console.log(`  participant keys: ${signal.participantKeys.join(" ") || "(no roster)"}`);
      if (signal.participantShape.length > 0) {
        console.log("  one participant, as a key tree:");
        for (const line of signal.participantShape) console.log(`    ${line}`);
      }
      if (signal.publishers.length === 0) {
        console.log("  roster: nobody at all — the roster was empty or unread");
      }
      for (const person of signal.publishers) {
        console.log(
          `  roster ${person.name}${person.state ? ` (${person.state})` : ""}` +
            `${person.sharing ? " SHARING" : ""}: ${JSON.stringify(person.mediaStreams)}`,
        );
      }
      for (const [path, names] of Object.entries(signal.frameLinks)) {
        console.log(`  links on ${path}: ${names.join(" ")}`);
      }
      for (const [path, lines] of Object.entries(signal.mediaLines)) {
        console.log(`  sdp on ${path}:`);
        for (const line of lines) console.log(`      ${line}`);
      }
      console.log(`  links in the join answer: ${signal.joinLinks.join(" ") || "(none seen)"}`);

      const end = timeline().at(-1);
      console.log(
        `\n  final: ${end?.phase ?? "-"} ${end?.detail || end?.notice || ""}\n` +
          "  The backend journal has the frames: journalctl --user -u teams-lite-backend -n 60\n",
      );
    },
    { front, tone, from },
  );
}
