import { test as base, expect, type Locator, type Page } from "@playwright/test";

// A test fixture that tracks browser console errors and page errors, so specs
// can assert the app runs clean. Favicon 404s and the React devtools notice are
// filtered out as noise.
type Fixtures = {
  consoleErrors: string[];
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
});

export { expect };

/** The composer's editable field. The composer has ONE field and it is always the
 *  rich editor, so every spec drives this — there is no plain textarea to fall back
 *  to. The format bar only shows or hides buttons above it. */
export function composerField(page: Page) {
  return page.locator('[data-testid="composer-rich"] .tiptap-message');
}

/** Replace whatever the composer holds with `text`. `fill` works on a contenteditable,
 *  so this stays as terse as the old textarea call it replaces. */
export async function fillComposer(page: Page, text: string): Promise<void> {
  const field = composerField(page);
  await field.click();
  await field.fill(text);
}

/** Empty the composer, and leave nothing focused.
 *
 *  `fill("")` does not clear a contenteditable — it inserts nothing — and a draft is
 *  persisted per conversation, so one spec's leftovers are the next spec's opening state,
 *  across a reload and across a new page. The blur is what lets a spec assert who takes
 *  the caret next. */
export async function clearComposer(page: Page): Promise<void> {
  const field = composerField(page);
  await field.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Write `text` in the composer and send it with Enter. */
export async function sendFromComposer(page: Page, text: string): Promise<void> {
  await fillComposer(page, text);
  await composerField(page).press("Enter");
}

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

/**
 * Open a conversation BY NAME, through the command palette, and wait for its messages.
 *
 * A test whose subject is a conversation's own state — its agent mode, its draft, its
 * history — must name it rather than index it. The sidebar's order is shared state: one
 * mock process serves the whole run, and any earlier spec that sent a message moved the
 * rows under everybody else. That is not a theory: an index landed on the agent sandbox,
 * a test toggled "the switch of the thread at index 1" and turned the one thread that is
 * opted in out of the box OFF — which broke two other files, in a way that reproduced
 * only in a full run.
 */
export async function openConversationNamed(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText(name);
  await expect
    .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

// ---- the conversation's own menu ---------------------------------------------
//
// The header carries ONE control, and everything the conversation offers is a ROW inside it:
// the call it places or the meeting it joins, a game of chess, whether the chat is encrypted,
// and whether this thread answers an `@claude` message
// (web/src/components/conversation-menu.tsx). It used to be three separate controls in that
// slot, each drawn only where it applied — so the second control from the right was a
// different action in every thread.
//
// Every row kept the testid its button had, so the ONE thing that changed for a spec is that
// it has to OPEN the menu before it can reach any of them. That is spelled once here rather
// than at each of the forty presses.

/** The trigger — readable WITHOUT opening anything, which is the point of what it carries:
 *  the agent mode, the live game, and whether that game wants something from the reader. */
export function conversationMenuTrigger(page: Page): Locator {
  return page.locator('[data-testid="conversation-menu"]');
}

/**
 * Open it, and wait for the one row EVERY conversation has.
 *
 * IDEMPOTENT, because the mock's live feed re-renders the pane every few seconds and a
 * non-modal Radix menu can be unmounted in that window — so a spec that reaches for a second
 * row after a round trip may find the menu gone. A bare click would toggle an open one shut.
 */
export async function openConversationMenu(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="conversation-menu-content"]').count())) {
    await conversationMenuTrigger(page).click();
  }
  // The agent switch, and not the call: a channel offers no call, Notes offers no game, and
  // neither can be waited on as proof that the menu is open.
  await expect(page.locator('[data-testid="agent-mode-toggle"]')).toBeVisible();
}

/**
 * Close it again by pressing its own trigger — NEVER with Escape.
 *
 * The app shell keeps a window-level Escape that leaves the open conversation, and it stands
 * aside for a `[role="dialog"]` only (`aModalIsOpen` in web/src/lib/platform.ts). A menu is
 * `role="menu"`, so Escape here closes the menu AND walks out of the thread behind it —
 * which is how a spec that pressed it lost the composer it was about to assert on.
 */
export async function closeConversationMenu(page: Page): Promise<void> {
  const content = page.locator('[data-testid="conversation-menu-content"]');
  if (!(await content.count())) return;
  await conversationMenuTrigger(page).click();
  await content.waitFor({ state: "detached" });
}

/** Open the menu and press one of its rows, then wait for the menu to go. For the rows that
 *  ACT — the call, the join, the challenge — as against the switches, which deliberately hold
 *  the menu open so the user watches them settle. */
export async function pressConversationMenuRow(page: Page, testId: string): Promise<void> {
  await openConversationMenu(page);
  await page.locator(`[data-testid="${testId}"]`).click();
  await page
    .locator('[data-testid="conversation-menu-content"]')
    .waitFor({ state: "detached" });
}

/** Place the call the open conversation offers — one person in a 1:1, everybody at once in a
 *  group chat. Two presses now, which is what the one-trigger header costs. */
export async function callFromMenu(page: Page): Promise<void> {
  await pressConversationMenuRow(page, "call-button");
}

/** JOIN the meeting the open thread was minted for. A calendar event keeps its own labelled
 *  "Join here" beside its way out to Teams, so a spec on that surface clicks the button
 *  directly and never comes through here. */
export async function joinMeetingFromMenu(page: Page): Promise<void> {
  await pressConversationMenuRow(page, "meeting-join-here");
}

export type CapturedSend = {
  conversation: string;
  text: string;
  content_html?: string;
  /** Who the body's mention spans name, by the itemid each span carries. Present only
   *  when the message @mentions somebody. */
  mentions?: {
    itemid: number;
    mri: string;
    display_name: string;
    /** What it names, absent for a person (see `teams_send::MentionKind`). */
    kind?: "person" | "channel";
  }[];
  /** Every picture the message carried, in the order the composer sent them. */
  images?: {
    name: string;
    content_type: string;
    data_base64: string;
    width?: number;
    height?: number;
  }[];
  /** When Teams is to DELIVER the message, in epoch milliseconds. Present only when the
   *  reader scheduled it — a held message appears in no thread, so this is the only proof
   *  the moment they picked really left the composer. */
  scheduled_time?: number;
  /** The post's TITLE. Present only on a titled channel post, and its being a field of
   *  its own here is the point: the title is a property of the message, never words in
   *  its body. */
  subject?: string;
  /** The CHANNEL THREAD the post belongs to. Present only on a reply into one, and its
   *  being a field rather than a quote in the body is the point: Teams files a channel reply
   *  by ADDRESS, so this is the only proof the answer lands under the announcement instead
   *  of opening a second thread beside it. */
  thread_root?: string;
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

/** One EDIT the page made, as the mock recorded it. */
export type CapturedEdit = {
  conversation: string;
  message_id: string;
  text: string;
  content_html?: string;
};

/**
 * Every edit the page has made, in order.
 *
 * A chess MOVE is an edit of the player's own ledger message rather than a new message (see
 * web/src/lib/chess-wire.ts), so this is what proves a move really left — the thread gains no
 * message for a spec to read the wire off.
 */
export async function fetchCapturedEdits(page: Page): Promise<CapturedEdit[]> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/sends`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { edits?: CapturedEdit[] };
  return body.edits ?? [];
}

/** Inject a live message through the mock's gated test hook. */
export async function emitLive(
  page: Page,
  body: {
    conversation: string;
    content: string;
    sender?: string;
    is_self?: boolean;
    reply?: boolean;
    /** The body verbatim, when the spec is about the markup — `content` is escaped. */
    html?: string;
  },
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

/**
 * Ring THIS machine, the way an invite on the calling socket does (the mock's
 * `call_invite` hook, mirroring `calling::incoming_call_from_frame`).
 *
 * Different from {@link emitCall}: that one is the awareness signal built from an
 * after-the-fact chat event and can only raise a banner, while this is a call the app can
 * really answer. Ringing implies calling is ON, because a real invite could not arrive
 * otherwise.
 *
 * ALWAYS finish with `resetCall`. One mock process serves the whole run, so a call left
 * ringing would ring inside every later spec.
 */
export async function emitCallInvite(page: Page, conversation: string): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_invite", conversation },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Make this window's backend one that does not take calls at all.
 *
 * There is no switch in the app — every backend the user launches registers as a device
 * their calls ring on at startup — so this hook is the only way to that state, and it is
 * the state ONE real backend reports: a read-only one, which is the install they never
 * opened. What it exercises is that the call and Join controls stay, disabled, saying so.
 * Always finish with `resetCall`.
 */
export async function disableCalling(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "calling", enabled: false },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Make ONE step of the next start answer late, so a spec can hang up inside it.
 *
 * A real start waits on a microphone and on ICE gathering, then on the POST that rings the
 * far side; the mock's own media is instant, so without this the window a user cancels in
 * does not exist here at all. `"prepare"` holds the reservation — the stage is up, the
 * offer has not gone out — and `"place"` holds the invite on the wire, which is the half
 * the backend has to take back. Always finish with `resetCall`.
 */
export async function holdCallStart(
  page: Page,
  hold: "prepare" | "place",
  holdMs = 1500,
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_start", hold, hold_ms: holdMs },
  });
  expect(res.ok()).toBeTruthy();
}

/** End any mock call and put calling back to what a real backend reports — it calls. It
 *  also clears an armed media refusal, an armed `disableCalling` and an armed start hold,
 *  so none of them needs a separate undo. */
export async function resetCall(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_invite", reset: true },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Make the next camera or screen the user turns on FAIL, once — the service refusing new
 * media on a live call.
 *
 * It is the only reachable mid-call failure: `simulatedCallMedia` never refuses a capture,
 * and the service that would is a real tenant. What it exercises is that the reason is
 * SAID (it used to be swallowed — the card that carried it was drawn only while no call was
 * live) and said clear of the card holding Hang up. Always finish with `resetCall`.
 */
export async function refuseNextCallMedia(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_media", refuse: true },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * End the live call the way the SERVICE ends one, with its own reason.
 *
 * The reason this exists for is a call that rang NOTHING — the callee has no client signed in
 * — because the mock rings no devices and a real one needs a colleague who is offline. What it
 * exercises is the sentence: an ending the user did not choose has to say why, or a call that
 * stops two seconds after they pressed call reads as this app dropping it.
 */
export async function endCallWithReason(page: Page, reason: string): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_end", reason },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Have the MEETING drop a capture the page is sending, the way the service does it: one
 * offer that rejects the section.
 *
 * It arms nothing — the drop happens on the live call at once — so there is nothing for a
 * later spec to inherit. What it exercises is the state the page is left in: the capture
 * released, the button off, and one sentence saying why, because nothing else on the page
 * would tell the user their camera stopped.
 */
export async function dropCallCapture(page: Page, kind: "camera" | "screen"): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_media", drop: kind },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Have the meeting REFUSE a capture the page just turned on: the answer to our own offer,
 * with the section rejected.
 *
 * It is the state a screen share really met on this tenant, and it is not a drop — nothing
 * was ever shown. The app used to say it was, so the user was told to share again and met the
 * same refusal in the same second, which is what this pins.
 */
export async function rejectCallCapture(page: Page, kind: "camera" | "screen"): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_media", reject: kind },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * The ORDER the sharing calls reached the mock in.
 *
 * The one rule of a screen share that no screen shows: a meeting grants ONE screen at a time,
 * so the content-sharing session is asked for BEFORE the section is offered — an app that
 * offered first looks right and shares nothing, which is what the tenant answered on
 * 2026-08-06. Reset with the call, like everything else about it.
 */
export async function callSharingOrder(page: Page): Promise<string[]> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_sharing_order" },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { order: string[] }).order;
}

/**
 * Answer an offer of the page's in a way no browser can read — the third way a capture ends
 * with no click behind it, and the one that used to cost the whole call.
 *
 * It arms nothing: the answer goes out on the live call at once. What it exercises is the
 * reaction that was WRONG — this app hung up, so a user who shared their screen lost the
 * person they were talking to seconds later — against the rule the surface is built on: a
 * failure in a renegotiation costs one picture and never the call.
 */
export async function answerCallMediaUnreadably(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call_media", unreadable: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm (or clear) a pending update in the mock, through its gated test hook; the mock
 *  then broadcasts `update_available`, mirroring the Rust backend's own event.
 *
 *  `can_install: false` is the install this app cannot replace itself (a staged
 *  always-on service, in practice), which keeps a link instead of a button.
 *
 *  ALWAYS clear it with `{ available: false }` before the spec ends. The mock is a
 *  shared process and `reuseExistingServer` adopts it across runs, so an update left
 *  armed would add a row to every later sidebar. */
export async function emitUpdate(
  page: Page,
  body: {
    available?: boolean;
    current?: string;
    latest?: string;
    url?: string;
    size?: number;
    can_install?: boolean;
    /** Make the next download fail, once — the replaced-asset failure the user really
     *  hit. What follows it is the retry, which has to work. */
    fail_once?: boolean;
    /** `false` is the backend that could NOT read what the update brings (offline,
     *  rate-limited, a force-pushed history). The button must still be offered. */
    changes?: false;
    /** A build so far behind that the list is capped: the panel then states how many
     *  changes it is not showing. */
    changes_omitted?: number;
    /** Simulate the restart an apply ends in: the backend drops every socket, and the
     *  one that answers next is the new build, with no update to announce. */
    restarted?: boolean;
  } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "update", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm what Settings › This app is answered with, through the mock's gated test hook: the
 *  outcome of an update check, how many agent replies a restart would cut off, and the
 *  machine that has nothing to restart its backend at all.
 *
 *  ALWAYS reset it with `{ reset: true }` before the spec ends. The mock is a shared process
 *  and `reuseExistingServer` adopts it across runs, so a backend armed to refuse a restart
 *  would refuse for every later spec. */
export async function emitMaintenance(
  page: Page,
  body: {
    /** Override what `update_check` answers. Only the outcomes the mock cannot genuinely be
     *  in need arming — "available" and "current" come from the release it holds. */
    check?: "available" | "current" | "busy" | "unknown" | "unsupported" | "failed";
    /** How many agent replies this backend is writing: what makes the armed "Restart
     *  anyway" reachable. */
    runs?: number;
    /** The install nothing would restart — no launcher, no supervisor. The one refusal the
     *  user cannot press through. */
    refuse?: boolean;
    reset?: boolean;
  } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "maintenance", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm where the page stands with the write lock in the mock, through its gated test
 *  hook. `foreign` is the state in which every read answers and every outward action is
 *  refused — the one the banner exists for.
 *
 *  ALWAYS reset it with `{ reset: true }` before the spec ends. The mock is a shared
 *  process and `reuseExistingServer` adopts it across runs, so a banner left armed would
 *  sit above every later sidebar. */
export async function emitWriteLock(
  page: Page,
  body: { state?: "held" | "foreign" | "read_only"; pinned?: boolean; reset?: boolean } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "write_lock", ...body },
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
    /** Whether this pretend machine can serve the broker's own sign-in window — the remedy
     *  for the failure a container restart cannot fix (see e2e/signin.spec.ts). */
    can_sign_in?: boolean;
    signin_blocker?: string;
  } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "broker", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm what the mock's NEXT sign-in does, or reset the hook.
 *
 *  `window` (the default) puts a window up and waits for the reader; `immediate` finishes with
 *  nobody typing, which is the common case against the real broker; `refuse` answers the
 *  refusal a machine with no display gives; `fail` ends the flow after the window is up; `hold`
 *  stays in `starting` with no window, which is where most sign-ins live.
 *
 *  A spec MUST reset it, which also forgets a session in flight: one mock process serves the
 *  whole run, and a sign-in left running would put a dialog over every later spec. */
export async function armSignin(
  page: Page,
  body: { outcome?: "window" | "immediate" | "refuse" | "fail" | "hold"; reset?: boolean },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "signin", ...body },
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

/** Move the "Always available" hours from OUTSIDE the page, through the mock's gated test
 *  hook, and broadcast the settings the way the backend's heartbeat does when a window
 *  turns (`settings_changed`).
 *
 *  It is the only way to reach that moment from a spec: the real backend notices at 19:00
 *  that it is past the window and withdraws the registration with nobody clicking anything,
 *  and this mock holds no clock loop. Turning the switch off undoes it, so it needs no reset
 *  of its own. */
export async function emitPresenceHours(
  page: Page,
  body: { from?: string | null; to?: string | null; enabled?: boolean },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "presence", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Clear every name and face the user gave somebody, through the mock's gated test
 *  hook. One mock process serves the whole run, so a rename left behind would rename
 *  that person for every later spec. */
export async function clearPersonOverrides(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "person_overrides", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Drop every message the mock is HOLDING for later, through its gated test hook.
 *
 *  A spec that queues one MUST call this: a held message outlives the page — one mock
 *  process serves the whole run — so it would sit in every later spec's banner and
 *  scheduled list. */
export async function clearScheduledMessages(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "scheduled", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm what GitLab says about an approval, through the mock's gated test hook: a refusal
 *  sentence, a machine with no token at all (`unavailable`), or — with `clear` — a clean
 *  slate. A spec that arms one MUST clear it: one mock process serves the whole run, and a
 *  left-behind refusal turns every later approval into an error nobody armed. */
export async function setApprovalControl(
  page: Page,
  body: { refuse?: string; unavailable?: boolean; clear?: boolean },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "gitlab_approval", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Arm what GitLab says about the merge-request PAGE's writes, through the mock's gated
 *  test hook: a refusal sentence (`refuse`), a machine with no token (`no_token`), or a
 *  clean slate (`clear`).
 *
 *  A spec MUST clear whatever it arms. One mock process serves the whole run, so a refusal
 *  left behind turns every later merge on that surface into an error nobody armed. */
export async function setMergeRequestControl(
  page: Page,
  body: {
    refuse?: string;
    no_token?: boolean;
    refuse_diff?: string;
    refuse_upload?: string;
    /** Make the JOB LOG read fail with this sentence. Its own switch beside the diff's, because
     *  the log page IS that read: a refusal there is the whole screen. */
    refuse_job_log?: string;
    /** Answer the JOB in full and refuse its LOG with this sentence — the shape GitLab takes when
     *  a trace file is gone. The page must state it rather than "this job printed nothing". */
    refuse_trace?: string;
    /** Answer the job log as the TAIL of a much bigger one, which is the state the page has to
     *  tell the reader about. */
    truncate_job_log?: boolean;
    /** Make the next AI READING of a diff refuse with this sentence — a CLI that is not on this
     *  machine's PATH, a provider the user switched off. It has to be reported beside the button
     *  that was pressed. */
    refuse_review?: string;
    /** Make the next FOLLOW-UP question refuse with this sentence. Its own switch beside the
     *  reading's, because the two are reported in different places: a refused reading at the button
     *  and a refused question at the box the words are still in. */
    refuse_ask?: string;
    /** HOLD the next follow-up for this many ms before answering. The optimistic draw — the question
     *  in its own bubble with the box already empty and no answer yet — has no duration against a mock
     *  that answers in one frame, so this is the only way a spec or a capture can see it at all. */
    hold_ask?: number;
    /** HOLD an AI reading AT this stage (`detail` | `diff` | `asking` | `writing`), so the state the
     *  progress rows are drawn from can be asserted at all. Two of those stages are minutes of a real
     *  run and one frame of this mock's, so without it there is no moment to catch — the same gap
     *  `hold_ask` fills, for the run rather than for a question. */
    hold_review?: "detail" | "diff" | "asking" | "writing";
    /** Put a CONVERSATION about the reading in place without asking anything, so a spec and a
     *  capture can reach a transcript without paying for a turn per picture. It needs a reading, so
     *  it implies one. */
    chat?: "stored";
    /** Put a reading of every mock diff in place WITHOUT a run, so a spec can reach the stored path
     *  without pressing anything — and `"stale"` makes it a reading of another commit, which the
     *  page has to say rather than drawing a grouping of files that may have moved. */
    review?: "stored" | "stale";
    clear?: boolean;
  },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "gitlab_mr", ...body },
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
    /** Whose reaction it is. Omitted, the mock names the first colleagues of its
     *  roster; `[]` leaves every reactor unnamed, which is a real state (nobody this
     *  machine has seen write) and the one a chip's tooltip counts rather than names. */
    mris?: string[];
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
export async function fetchAgentModes(page: Page): Promise<{
  sandbox: string;
  conversations: { conversation: string; mode: string }[];
  tools: string[];
  providers: { name: string; available: boolean; enabled: boolean; model: string | null }[];
  unrestricted: boolean;
  default_provider: string;
}> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/agent`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * Arm which agent CLIs the mock machine holds, and which provider is the default.
 *
 * A machine with TWO usable providers is what proves the split: a message's ⋯ menu offers
 * the default alone, and the composer's own "@" still offers both. The mock installs one
 * CLI out of the box, so a spec that needs the second one arms it here.
 *
 * **Reset it afterwards** (`setAgentProviders(page, "reset")`). One mock process serves the
 * whole run, and a second CLI left installed changes what every later spec's menu holds.
 * Arm it BEFORE `gotoApp`: the page reads `agent_status` when it connects.
 */
export async function setAgentProviders(
  page: Page,
  body: { available?: Record<string, boolean>; default?: string } | "reset",
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data:
      body === "reset"
        ? { kind: "agent_providers", reset: true }
        : { kind: "agent_providers", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Put the mock's CUSTOM AGENTS back the way it declares them — the two the seeded state holds
 * (`bebou` with a face, `natacha` with a model and none).
 *
 * **Every spec that adds, edits or removes one must call this afterwards.** One mock process
 * serves the whole run, and a third agent left behind changes what every later composer's "@"
 * offers — and a `bebou` whose face was removed changes what every later chip draws.
 */
export async function resetAgentPersonas(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "agent_personas" },
  });
  expect(res.ok()).toBeTruthy();
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

/**
 * Assert a tracker preview card fits the width it was given, in both directions:
 * its own box stays inside the conversation pane, and its text stays inside its box.
 * The two are independent failures — a card wider than the pane runs off the side of
 * a phone, and one whose lines cannot shrink spills its badges past its own edge —
 * and a long project path, branch or team name is what provokes either.
 */
export async function expectCardFitsItsPane(card: Locator, pane: Locator): Promise<void> {
  const cardBox = await card.boundingBox();
  const paneBox = await pane.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  // A hair of tolerance for sub-pixel layout, and none for a real overflow.
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1);
  expect(cardBox!.x).toBeGreaterThanOrEqual(paneBox!.x - 1);

  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

// ---- chess ------------------------------------------------------------------
//
// A game needs two machines and the suite has one, so the mock plays the OPPONENT: it accepts a
// challenge and answers each move with a legal reply (see `maybeAnswerMockChess`). These aim it.

/**
 * Aim the chess opponent: name the move it answers with, or silence it.
 *
 * ALWAYS finish with `resetChess`. One mock process serves the complete E2E run, and an opponent
 * left silent leaves every later game unanswered.
 */
export async function setChessOpponent(
  page: Page,
  body: { reply?: string; silent?: boolean } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Have the OPPONENT open a game, so the reader is the one challenged.
 *
 * This exists because its absence hid a shipped bug: the mock accepted every challenge itself,
 * so the Accept path was never the reader's — and the app had no Accept button while every test
 * passed. `color` is the colour the OPPONENT takes, so the reader plays the other one.
 */
export async function chessChallengeFromOpponent(
  page: Page,
  color: "w" | "b" = "w",
): Promise<string> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess", challenge: color },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { game: string | null };
  expect(body.game).toBeTruthy();
  return body.game as string;
}

/**
 * Seed a game already UNDER WAY: both ledgers, the moves played, and each side's clock where the
 * caller says. It is the only way to reach a running clock, a nearly-flagged one or a long score
 * sheet without waiting ten minutes for a number to move.
 *
 * `mine` is the READER's colour, `clock` is what each side has left in ms, and the answer is the
 * game's own id — which is also the last segment of its page's address.
 */
export async function seedChessGame(
  page: Page,
  body: {
    mine?: "w" | "b";
    moves?: string[];
    clock?: { w?: number; b?: number };
    base?: number;
    increment?: number;
    conversation?: string;
    /** Seed a FINISHED game, which is what a head-to-head SCORE and a REMATCH are counted from —
     *  neither exists on a game that is still going, and playing one out is twenty presses. */
    ending?: "weResigned" | "theyResigned" | "draw";
  } = {},
): Promise<string> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess", seed: body },
  });
  expect(res.ok()).toBeTruthy();
  const answer = (await res.json()) as { game: string | null };
  expect(answer.game).toBeTruthy();
  return answer.game as string;
}

/** Put the chess opponent back the way the mock declares it. */
export async function resetChess(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess", reset: true },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Open the conversation's menu and DISCLOSE the challenge form inside it — the colour row and
 * the sentence saying what the press costs.
 *
 * Two presses, exactly as the popover this replaced took: the menu, then the row. The fold is
 * deliberate (a reader who opened the menu to flip the agent switch must not be handed a chess
 * setup form), so the disclosure is asked for rather than assumed — and it is asked for
 * IDEMPOTENTLY, because pressing the row again folds it back up.
 */
export async function openChessChallenge(page: Page): Promise<void> {
  await openConversationMenu(page);
  if (!(await page.locator('[data-testid="chess-challenge"]').count())) {
    await page.locator('[data-testid="chess-button"]').click();
  }
  await expect(page.locator('[data-testid="chess-challenge"]')).toBeVisible();
}

/**
 * Challenge from the open conversation's header and wait for the mock to accept.
 *
 * The colour is asked for explicitly rather than left random: a spec that did not know which
 * side it was on could not know whose move it is, and would have to branch on the answer.
 */
export async function startChessGame(page: Page, color: "w" | "b" = "w"): Promise<void> {
  await openChessChallenge(page);
  await page.locator(`[data-testid="chess-color-${color}"]`).click();
  await page.locator('[data-testid="chess-challenge"]').click();
  // The challenge closes the menu only when it really went out, which is what makes the
  // board's arrival the thing to wait on rather than the menu's disappearance.
  await page.locator('[data-testid="chess-game"]').waitFor();
  // The board is playable only once somebody is opposite.
  await expect(page.locator('[data-testid="chess-status"]')).not.toContainText(
    /waiting for somebody to accept/i,
    { timeout: 10_000 },
  );
}

// ---- the chess ENGINE -------------------------------------------------------
//
// The real engine is 7.3 MB the backend fetches; the suite serves a STUB instead (see
// mock/engine-stub.js and e2e/global-setup.ts). What the mock owns is the ANSWER a page reads —
// whether an engine is on "this machine" — which is what decides whether a game against the
// computer is offered at all.

/**
 * Say whether this machine holds the engine, or arm the fetch to fail.
 *
 * ALWAYS finish with `resetChessEngine`: one mock process serves the whole run, and an engine left
 * present would let a later spec pass without ever pressing the row that fetches one.
 */
export async function setChessEngine(
  page: Page,
  body: { present?: boolean; error?: string } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "engine", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Say whether this "machine" holds chess.com's board recordings. Nothing is fetched or served
 *  either way (they are not in this repository, and the suite's own sound directory stays empty) —
 *  what this decides is whether the page tries to LOAD them or falls back to synthesis. */
export async function setChessSounds(
  page: Page,
  body: { present?: boolean } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess_sound", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Put the board's sounds back the way the mock declares them: absent. */
export async function resetChessSounds(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess_sound", reset: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Put the engine back the way the mock declares it: absent, and armed to fail at nothing. */
export async function resetChessEngine(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "engine", reset: true },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Open the conversation's menu and DISCLOSE what it offers about the computer — the fetch row when
 * the engine is absent, the strength picker when it is here.
 */
export async function openChessEngineRow(page: Page): Promise<void> {
  await openConversationMenu(page);
  if (!(await page.locator('[data-testid="chess-engine-download"]').count())) {
    if (!(await page.locator('[data-testid="chess-engine-play"]').count())) {
      await page.locator('[data-testid="chess-engine-row"]').click();
    }
  }
}

/** Have the OPPONENT play its next move in one game, now — the only way to reach the moment a
 *  premove fires, since a premove posts nothing until it is legal. */
export async function chessOpponentMoves(page: Page, game: string): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "chess", play: game },
  });
  expect(res.ok()).toBeTruthy();
}

/** Open one game's own full-screen PAGE from the card in the history. */
export async function openChessPage(page: Page): Promise<void> {
  await page.locator('[data-testid="chess-open-page"]').first().click();
  await expect(page.locator('[data-testid="chess-page"]')).toBeVisible();
  // The board is what the page is for, so nothing is asserted until one is drawn.
  await page.locator('[data-testid="chess-board"]').first().waitFor();
}

/** Play a move by pressing the piece's square and then its target — the tap-tap a phone uses. */
export async function playChessMove(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

/** The middle of a square, which every gesture below is aimed at. */
async function chessSquareCentre(page: Page, square: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-square="${square}"]`).boundingBox();
  expect(box, `no square ${square} on screen`).toBeTruthy();
  const at = box as NonNullable<typeof box>;
  return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}

/**
 * Play — or QUEUE — a move by DRAGGING the piece, which is what a desktop reader does.
 *
 * It is a separate helper from {@link playChessMove} rather than an option on it, because the two
 * reach the board through different halves of the renderer — tap-tap through its square handler,
 * this through dnd-kit — and a premove was reachable by only one of them: the board disabled every
 * piece while it was not the reader's turn, so a whole gesture was dead and every spec passed.
 */
export async function dragChessPiece(page: Page, from: string, to: string): Promise<void> {
  const origin = await chessSquareCentre(page, from);
  const target = await chessSquareCentre(page, to);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  // dnd-kit starts a drag a pixel into the movement, so a jump straight onto the target square is
  // a click as far as the renderer is concerned.
  await page.mouse.move(origin.x + 4, origin.y + 4);
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}

/** A right press on one square, with no drag — how a premove is taken back. */
export async function rightClickChessSquare(page: Page, square: string): Promise<void> {
  const at = await chessSquareCentre(page, square);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
}

/** A right DRAG, which draws an ARROW and must never be read as a press that cancels one. */
export async function drawChessArrow(page: Page, from: string, to: string): Promise<void> {
  const origin = await chessSquareCentre(page, from);
  const target = await chessSquareCentre(page, to);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up({ button: "right" });
}

/** Whether a square holds a piece. */
export async function chessSquareHasPiece(page: Page, square: string): Promise<boolean> {
  return (await page.locator(`[data-square="${square}"] [data-piece]`).count()) > 0;
}

// ---- the CREATURE a conversation keeps ---------------------------------------
//
// A pet IS its messages (web/src/lib/pet-thread.ts), so there is no pet state anywhere for a spec
// to arrange: everything is a ledger message in the thread, and the only two ways one appears are
// the reader's own press and the COLLEAGUE's install — which is a machine this suite does not have.
// That is what the `{kind:"pet"}` hook stands in for.

/** The thread the creatures live in. Its own fixture, because a pet is a message that STAYS. */
export const PET_THREAD_NAME = "Pet Corner";

/** Its id — what the composer's own sentinel says, and what a live event has to be aimed at. */
export const PET_THREAD_ID = "19:pet-demo@thread.v2";

/**
 * The colleague's own half: they take a creature (`colleague`), do something to the reader's
 * (`act`), pat it (`pat`), or answer nothing at all (`silent`).
 *
 * `silent` has to be armed BEFORE the reader's first spawn to be worth anything — the colleague
 * answers a spawn 350 ms later — so a spec that wants to be alone with one pet arms it first.
 *
 * ALWAYS finish with `resetPet`. One mock process serves the whole run and a pet is a message, so a
 * creature left behind is a sprite in every later spec's history and a row in its menu.
 *
 * **THE THREAD IS `PET_THREAD_ID` AND IS NOT AN ARGUMENT.** It took one, and `resetPet` only ever put
 * that fixture back — so a spec aiming elsewhere left a ledger in another conversation for the whole
 * run. Widening it means widening the reset in the same change.
 */
export async function setPetHook(
  page: Page,
  body: {
    colleague?: boolean;
    act?: "feed" | "play" | "nap";
    pat?: boolean;
    silent?: boolean;
  } = {},
): Promise<{ pet: string | null; acted: boolean; patted: boolean }> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "pet", ...body },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { pet: string | null; acted: boolean; patted: boolean };
}

/** Put the colleague back the way the mock declares it, and the pet thread back to its seed. */
export async function resetPet(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "pet", reset: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** One creature's canvas — anybody's, or the one a pet id names. */
export function petSprite(page: Page, petId?: string): Locator {
  return page.locator(
    petId ? `[data-testid="pet-sprite"][data-pet="${petId}"]` : '[data-testid="pet-sprite"]',
  );
}

/**
 * The READER'S OWN creature, found by the one thing on screen that says whose a pet is.
 *
 * A canvas carries no words, so the trigger in each lane is a NAME — "You" for the reader's own and
 * a colleague's first name for theirs (pet-menu.tsx). It is matched on that rather than on DOM
 * order, because the order the lanes are laid out in is the FOLD's and a colleague's creature can
 * perfectly well be first: a spec that took `.first()` would silently drive somebody else's pet.
 */
export function ownPetTrigger(page: Page): Locator {
  return page.locator('[data-testid="pet-menu-trigger"]', { hasText: "You" });
}

/**
 * TAKE a companion from the conversation's own menu, and wait for it to be walking.
 *
 * The art is picked first because that is the shape the menu has — three `PickButton`s over one
 * row — and the press is ONE press, never armed. It returns the reader's own pet id.
 *
 * NOTE what it does NOT do: silence the colleague. The mock answers a first spawn by taking a
 * creature of its own ~350 ms later, so a caller that needs to be alone with one pet arms
 * `setPetHook(page, { silent: true })` BEFORE this.
 */
export async function spawnPet(page: Page, skin = "cat"): Promise<string> {
  await openConversationMenu(page);
  await page.locator(`[data-testid="pet-spawn-skin-${skin}"]`).click();
  await page.locator('[data-testid="pet-spawn"]').click();
  // THE MENU CLOSES ITSELF on a successful spawn (`setOpen(false)` in conversation-menu.tsx), so
  // this WAITS for that rather than pressing the trigger — and the wait is also the only thing that
  // pins it. Pressing was wrong twice over: a press that lands while the menu is mid-close RE-OPENS
  // it, and then nothing ever detaches. That failed only in a FULL run, where the timing differs.
  await page
    .locator('[data-testid="conversation-menu-content"]')
    .waitFor({ state: "detached", timeout: 15_000 });
  // The row publishes a `send`, so the creature appears only when its own ledger comes back.
  const trigger = ownPetTrigger(page);
  await trigger.waitFor({ state: "attached", timeout: 15_000 });
  const id = await trigger.getAttribute("data-pet");
  expect(id).toBeTruthy();
  return id as string;
}

/**
 * The SIDEBAR ROW of a conversation, scrolling the list until it is in the DOM.
 *
 * The chat list is virtualized, so a row far enough down is simply not rendered — and Pet Corner is
 * deliberately the OLDEST fixture in the mock, with its sidebar time FROZEN there (a fixture that
 * moved to the top the moment a spec posted into it would move the row under every other spec's
 * index). So it is always below the fold, whatever the reader has just done in it, and a spec that
 * wants to read its PREVIEW has to walk down to it. This is `preview.ts`'s own walk, scoped to one
 * list.
 */
export async function conversationRow(page: Page, name: string): Promise<Locator> {
  const rows = page.locator('[data-testid="conversation-row"]');
  const match = rows.filter({ hasText: name });
  const scroller = page.locator('[data-testid="sidebar-scroll"]');
  for (let screens = 0; screens < 30; screens++) {
    if ((await match.count()) > 0) return match.first();
    const moved = await scroller.evaluate((node) => {
      const was = node.scrollTop;
      node.scrollTop = was + node.clientHeight * 0.8;
      return node.scrollTop > was;
    });
    if (!moved) break;
    await page.waitForTimeout(150);
  }
  await expect(match).toHaveCount(1);
  return match.first();
}

/** Open one creature's own menu — its trigger is the small named pill in that pet's lane. */
export async function openPetMenu(page: Page, petId?: string): Promise<void> {
  const trigger = page.locator(
    petId
      ? `[data-testid="pet-menu-trigger"][data-pet="${petId}"]`
      : '[data-testid="pet-menu-trigger"]',
  );
  await trigger.first().click();
  await expect(page.locator('[data-testid="pet-menu"]')).toBeVisible();
}

/** Filter out benign console noise so `consoleErrors` only holds real problems. */
export function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon/i.test(e) && !/Download the React DevTools/i.test(e) && !/404/.test(e),
  );
}
