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

export type CapturedSend = {
  conversation: string;
  text: string;
  content_html?: string;
  /** Who the body's mention spans name, by the itemid each span carries. Present only
   *  when the message @mentions somebody. */
  mentions?: { itemid: number; mri: string; display_name: string }[];
  /** Every picture the message carried, in the order the composer sent them. */
  images?: {
    name: string;
    content_type: string;
    data_base64: string;
    width?: number;
    height?: number;
  }[];
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

/** Clear every name and face the user gave somebody, through the mock's gated test
 *  hook. One mock process serves the whole run, so a rename left behind would rename
 *  that person for every later spec. */
export async function clearPersonOverrides(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "person_overrides", clear: true },
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

/** Filter out benign console noise so `consoleErrors` only holds real problems. */
export function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon/i.test(e) && !/Download the React DevTools/i.test(e) && !/404/.test(e),
  );
}
