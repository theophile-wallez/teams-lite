import { expect } from "@playwright/test";
import {
  test,
  closeConversationMenu,
  conversationMenuTrigger,
  emitLive,
  fetchAgentModes,
  fillComposer,
  gotoApp,
  openConversationAt,
  openConversationMenu,
  openConversationNamed,
} from "./helpers";

// The per-conversation switch that lets the local agent answer an `@claude` message
// (see web/src/components/conversation-menu.tsx, src/agent_policy.rs), and how the answer is
// drawn as it is written (web/src/components/agent-reply.tsx).
//
// The switch used to have a trigger of its own in the header, beside the call and chess. All
// three are rows of ONE menu now, so every test here opens that menu first — and the MODE is
// still stated on the trigger, which is what lets a wrong state be read without opening
// anything.
//
// The switch IS the consent gate of the feature: turning it on tells the machine it may
// post an answer under the user's name in that thread. So what this spec pins is the
// default (off, in a conversation nobody named) and the round-trip through the backend
// — never a local guess about the state.
//
// The reply is driven through the mock, which reproduces the flow rather than running a
// CLI: it posts the placeholder, narrates the run on `agent_stream` and edits the message
// on the way (see `simulateMockAgentRun` in web/mock/server.ts). Against the real tenant
// that end is exercised by `examples/agent_stream_probe.rs`, pinned to the sandbox
// channel and nowhere else.

test.describe("The local agent switch", () => {
  test("is off in a conversation nobody opted in, and names the prefix to type", async ({
    page,
  }) => {
    await gotoApp(page);
    // Named, not indexed: the subject of this test is a conversation's own mode, and the
    // sidebar's order belongs to whatever the rest of the run has already sent.
    await openConversationNamed(page, "Plain Text");

    const trigger = conversationMenuTrigger(page);
    await expect(trigger).toBeVisible();
    // Off is the backend's own default for every conversation but the sandbox, and the
    // trigger publishes the mode so a wrong state is visible without opening anything.
    await expect(trigger).toHaveAttribute("data-agent-mode", "off");

    await openConversationMenu(page);
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // The mock reports both CLIs as installed, so the hint is the instruction rather
    // than a refusal.
    await expect(page.locator('[data-testid="agent-hint"]')).toContainText("@claude");
  });

  test("opts the open conversation in, and the backend's answer is what shows", async ({
    page,
  }) => {
    await gotoApp(page);
    // Named for a stronger reason than the test above: this one FLIPS the switch, so an
    // index that landed on the sandbox would take the one consent that is granted out of
    // the box away from every spec after it. It ends OFF, which is the state the two other
    // tests that read this thread expect.
    await openConversationNamed(page, "Plain Text");
    const conversationId =
      (await page
        .locator('[data-testid="composer-shell"]')
        .getAttribute("data-conversation-id")) ?? "";

    await openConversationMenu(page);
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    await toggle.click();

    // The menu stays open through the round-trip, so the user sees the switch settle.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(conversationMenuTrigger(page)).toHaveAttribute("data-agent-mode", "reply");

    // What the BACKEND stored, not what the page remembers clicking.
    const stored = await fetchAgentModes(page);
    expect(
      stored.conversations.find((c) => c.conversation === conversationId)?.mode,
    ).toBe("reply");
    // The sandbox stays opted in on its own, which is the one built-in exception.
    expect(stored.conversations.find((c) => c.conversation === stored.sandbox)?.mode).toBe(
      "reply",
    );

    // And off again, because a consent that cannot be withdrawn is not one.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  // The second half of the same consent: what the agent may READ. Before this existed,
  // the allowlist was reachable through a hand-crafted RPC only — which is the same as
  // unreachable, so an `@claude` question about Grafana was refused with nothing the
  // user could switch.
  test("grants one read-only group of tools, and takes it back", async ({ page }) => {
    await gotoApp(page);
    // The allowlist is per MACHINE, not per conversation, so any thread would do — but it
    // is still named: a row the rest of the run keeps re-ordering can move out from under
    // the click, and the header menu detaches with it.
    await openConversationNamed(page, "Thread Activity");

    await openConversationMenu(page);
    const files = page.locator('[data-testid="agent-tool-grant-files"]');
    const grafana = page.locator('[data-testid="agent-tool-grant-grafana"]');
    // The read-only default is what the backend starts at, and the only group on.
    await expect(files).toHaveAttribute("data-granted", "true");
    await expect(grafana).toHaveAttribute("data-granted", "false");

    await grafana.click();
    await expect(grafana).toHaveAttribute("data-granted", "true");

    // What the BACKEND stored, tool by tool — a switch that only changed the page would
    // leave the call refused.
    await expect
      .poll(async () => (await fetchAgentModes(page)).tools)
      .toContain("mcp__grafana__query_prometheus");
    // Granting one group keeps the other: the RPC replaces the whole list, so this is
    // where a lost tool would show.
    expect((await fetchAgentModes(page)).tools).toContain("Read");

    await grafana.click();
    await expect(grafana).toHaveAttribute("data-granted", "false");
    await expect
      .poll(async () => (await fetchAgentModes(page)).tools)
      .not.toContain("mcp__grafana__query_prometheus");
    await expect(files).toHaveAttribute("data-granted", "true");
  });

  // The widest setting: the agent then runs on the user's own Claude Code configuration,
  // so the groups above stop deciding anything. What this pins is the default (off, the
  // narrow state), the round-trip, and the fact the menu stops offering switches that
  // would decide nothing.
  test("hands the agent the user's own config only when asked, and says so", async ({
    page,
  }) => {
    await gotoApp(page);
    // Per machine too, and named for the same reason.
    await openConversationNamed(page, "Thread Activity");

    await openConversationMenu(page);
    const own = page.locator('[data-testid="agent-unrestricted-toggle"]');
    await expect(own).toHaveAttribute("aria-checked", "false");
    expect((await fetchAgentModes(page)).unrestricted).toBe(false);

    await own.click();
    await expect(own).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await fetchAgentModes(page)).unrestricted)
      .toBe(true);
    // The read-only groups no longer apply, so they are gone, and the menu says why.
    await expect(page.locator('[data-testid="agent-tool-grant-grafana"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="agent-unrestricted-warning"]')).toBeVisible();

    // And back, because a consent that cannot be withdrawn is not one.
    await own.click();
    await expect(own).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await fetchAgentModes(page)).unrestricted)
      .toBe(false);
    await expect(page.locator('[data-testid="agent-tool-grant-grafana"]')).toBeVisible();
  });
});

test.describe("The local agent's answer", () => {
  /** Opt the open thread in through its own header — the only place the app offers it.
   *
   *  It switches on and never off: the thread comes from the sidebar's order, which the
   *  rest of the run owns, so a blind click could land on a thread that is already opted
   *  in and take that consent away from every spec after this one. */
  async function optIn(page: import("@playwright/test").Page): Promise<void> {
    await openConversationMenu(page);
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await expect(conversationMenuTrigger(page)).toHaveAttribute("data-agent-mode", "reply");
    // Closed with its own trigger, not Escape: the app reads Escape as "close the
    // conversation", and it stands aside for a dialog only — never for a menu.
    await closeConversationMenu(page);
  }

  test("is written into the thread, on the side of what arrives", async ({ page }) => {
    await gotoApp(page);
    // Its own thread, named: this test reads THE one agent reply of the history, so a
    // thread another spec has already been answered in — the sandbox, which the sidebar's
    // order can put at any index — would match two bubbles and fail on the wrong thing.
    await openConversationNamed(page, "Forwarded Messages");
    await optIn(page);

    // A plain message first, so the history holds a same-author RUN for the spacing
    // assertion below to compare against. The fixtures alternate authors, and a thread
    // that shows one spacing cannot prove which of the two the reply takes.
    await fillComposer(page, "one moment");
    await page.keyboard.press("Enter");
    await fillComposer(page, "@claude which port is it?");
    await page.keyboard.press("Enter");

    // The run is on screen before a word of the answer is: the mark of the CLI that is
    // answering, and a line saying what it is doing.
    const stream = page.locator('[data-testid="agent-stream"]');
    await expect(stream).toBeVisible();
    await expect(page.locator('[data-testid="agent-status"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="agent-coin"][data-backend="claude"]').first(),
    ).toBeVisible();

    // THE thing this UI exists to get right. The reply went out through the user's own
    // account, so the wire calls it theirs — but they did not write it, and it takes the
    // side of everything that arrives rather than of everything they sent.
    //
    // Located by its signature, which is on the bubble from the placeholder onward — the
    // stream is an overlay and goes when the run ends, so a locator built on it would
    // stop matching exactly when the answer is complete.
    const bubble = page.locator('[data-testid="message"]', {
      has: page.locator('[data-testid="agent-signature"]'),
    });
    await expect(bubble).toHaveAttribute("data-mine", "false");

    // The bubble's own edge catches the light while the run writes into it. It is inside
    // the bubble and takes its radius, so it is the message's own hairline rather than a
    // box around it — and its box is measured against the bubble's, because a shine that
    // laid out at any other size would be a second, misaligned ring.
    const shine = bubble.locator('[data-testid="agent-shine"]');
    await expect(shine).toHaveCount(1);
    const rings = await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="agent-shine"]');
      const box = (n) => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      return JSON.stringify({
        shine: box(el),
        bubble: box(el.closest('[data-testid="message"]')),
        radius: getComputedStyle(el).borderTopLeftRadius,
        parentRadius: getComputedStyle(el.closest('[data-testid="message"]')).borderTopLeftRadius,
      });
    })()`);
    const ring = JSON.parse(rings) as {
      shine: number[];
      bubble: number[];
      radius: string;
      parentRadius: string;
    };
    expect(ring.shine).toEqual(ring.bubble);
    expect(ring.radius).toBe(ring.parentRadius);

    // A tool call is named while it runs, which is the whole point of streaming the run
    // rather than only the text. `.first()` is the run's FIRST call: every call keeps its
    // row (see the transcript test below), so the list only ever grows.
    await expect(page.locator('[data-testid="agent-activity"]').first()).toContainText("Grep");

    // It takes the gap the history puts between two AUTHORS, not the tight one it puts
    // inside one author's run. On the wire the reply IS the user's own message — same
    // account, same name — so it would chain against the question by default, and a reply
    // tucked under it reads as one person talking twice.
    //
    // The history uses exactly two spacings, so this compares the agent's with both: it
    // must be the wider one.
    const gaps = await page.evaluate(`(() => {
      const rowOf = (el) => el && el.closest("[data-testid=message]")?.parentElement;
      const top = (el) => (el ? parseFloat(getComputedStyle(el).marginTop) : -1);
      const all = [...document.querySelectorAll('[data-testid="message"]')].map((m) => top(m.parentElement));
      return JSON.stringify({
        agent: top(rowOf(document.querySelector('[data-testid="agent-signature"]'))),
        widest: Math.max(...all),
        tightest: Math.min(...all),
      });
    })()`);
    const { agent: agentGap, widest, tightest } = JSON.parse(gaps) as Record<string, number>;
    expect(agentGap).toBe(widest);
    expect(widest).toBeGreaterThan(tightest);

    // The answer arrives, and it is the CLI's own words — formatted, not a run-on line.
    await expect(stream).toHaveAttribute("data-phase", "writing");
    await expect(bubble).toContainText("19420", { timeout: 20_000 });

    // And when the run ends the overlay goes: the posted message is the record, and it
    // renders on its own from then on (which is what every reply this app never watched
    // being written does).
    await expect(page.locator('[data-testid="agent-status"]')).toHaveCount(0, {
      timeout: 20_000,
    });
    // And the light goes with it: nothing is arriving into that bubble any more, and an
    // edge that kept moving would promise a word that is never coming.
    await expect(page.locator('[data-testid="agent-shine"]')).toHaveCount(0);
    // The signature names both halves of the authorship: the CLI that wrote the words,
    // and the account they went out under.
    const signature = page.locator('[data-testid="agent-signature"]');
    await expect(signature).toBeVisible();
    await expect(signature).toContainText("Claude");
    await expect(signature).toContainText("by You");
    // The posted message ends with `— claude, via teams-lite`; that line is what a
    // colleague reads in a real Teams client. Here the mark says it instead, so the words
    // are stripped from the body rather than shown under it.
    await expect(bubble).not.toContainText("via teams-lite");
  });

  test("streams the whole transcript, holds it open for the run, then folds it", async ({
    page,
  }) => {
    await gotoApp(page);
    // Its own thread, named, for the same reason as the test above: this one counts the
    // rows of THE run on screen.
    await openConversationNamed(page, "App Cards");
    await optIn(page);
    await fillComposer(page, "@claude which port does the backend listen on?");
    await page.keyboard.press("Enter");

    const transcript = page.locator('[data-testid="agent-transcript"]');
    const steps = page.locator('[data-testid="agent-activity"]');
    const thoughts = page.locator('[data-testid="agent-thinking"]');
    // Open while the reasoning is what there is to show: this is the state the user
    // watches, and it used to be one truncated line that the next line replaced.
    await expect(transcript).toHaveAttribute("data-open", "true");
    await expect(thoughts.first()).toContainText("CLAUDE.md", { timeout: 20_000 });

    // A tool call is named while it runs, and the reasoning around it does not go with it.
    // Polled rather than counted at an instant: the run is a clock, and the number of rows
    // on screen at a given moment is the fixture's business, not this test's.
    await expect
      .poll(async () => await steps.count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(steps.first()).toContainText("Grep");

    // THE ANSWER STARTS ARRIVING AND THE PANEL STAYS OPEN. The work is what explains the
    // words being written, so it keeps its room for as long as the run has anything to add
    // to it. It used to fold on this exact frame, which took the reasoning away at the one
    // moment it was worth reading.
    const toggle = page.locator('[data-testid="agent-transcript-toggle"]');
    await expect(page.locator('[data-testid="agent-stream"][data-phase="writing"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(transcript).toHaveAttribute("data-open", "true");
    // Both calls are still on screen, with the reasoning around them, while the words of
    // the answer arrive under it. Asserted here and counted in full further down: the run
    // is a clock, and the last thought of this fixture is still being revealed at this
    // frame.
    await expect(steps).toHaveCount(2);
    await expect(thoughts.first()).toContainText("CLAUDE.md");

    // THE RUN ENDS, AND THE PANEL FOLDS ITSELF — once, into one row naming what it holds.
    // Nothing is arriving into it any more, so the answer is what the reader wants the room
    // for from here on. The overlay goes with it: the Teams message is the record again.
    await expect(page.locator('[data-testid="agent-stream"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(transcript).toHaveAttribute("data-open", "false");
    await expect(toggle).toContainText("Reasoning and 2 tool calls");
    await expect(steps).toHaveCount(0);

    // THE RUN IS OVER AND THE WORK IS NOT. It opens again on a click, and it is the whole
    // run: the transcript is kept beside the message, in the same place, so nothing moved at
    // the swap — the panel is remounted there, which is why the reader's fold is held per
    // message rather than inside it. It is the only place the reasoning exists at all; the
    // message carries the answer alone, which is why a reload leaves no panel.
    await toggle.click();
    await expect(transcript).toHaveAttribute("data-open", "true");

    // And what it holds is the WHOLE run, in the order it happened: nothing that went past
    // was thrown away. This is the assertion the old surface could not have passed — it
    // showed one truncated line of reasoning and one tool chip, each replaced by the next.
    await expect(steps).toHaveCount(2);
    await expect(steps.first()).toContainText("Grep");
    await expect(steps.first()).toHaveAttribute("data-done", "true");
    await expect(steps.nth(1)).toContainText("Read");
    await expect(thoughts).toHaveCount(3);
    await expect(thoughts.first()).toContainText("CLAUDE.md");
    // The reasoning that came BETWEEN the two calls sits between them.
    await expect(thoughts.nth(1)).toContainText("read-only port");

    // The panel is BOUNDED and scrolls itself. It sits in a virtualized history, so a
    // transcript that grew without a ceiling would push the whole conversation around one
    // frame at a time — and a reader who opened it is left on its newest line.
    const box = page.locator('[data-testid="agent-transcript-steps"]');
    await expect(box).toHaveCSS("max-height", "168px");
    await expect(box).toHaveCSS("overflow-y", "auto");
    const scroll = JSON.parse(
      await page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="agent-transcript-steps"]');
        if (!el) return "null";
        return JSON.stringify({
          scrolls: el.scrollHeight > el.clientHeight,
          gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        });
      })()`),
    ) as { scrolls: boolean; gap: number } | null;
    // Conditional on purpose: whether this fixture's reasoning overflows the ceiling
    // depends on how it wraps at this viewport, and asserting that it does would pin the
    // fixture rather than the behaviour.
    if (scroll?.scrolls) expect(scroll.gap).toBeLessThanOrEqual(24);

    // And the automatic fold never takes that click back: nothing re-folds a panel the
    // reader opened.
    await page.waitForTimeout(900);
    await expect(transcript).toHaveAttribute("data-open", "true");
  });

  // THE SIDEBAR NAMES THE AGENT, not the account the reply went out under.
  //
  // The row used to read "You: …ship it — claude, via teams-lite": the account, because the
  // reply really is posted through it, and the signature line, because a preview is the body's
  // own words. Both are wrong in a list — the thread's own bubble refuses the first (it draws
  // the CLI's mark where a sender's name goes) and strips the second — so the row says what the
  // bubble says, in the space a row has.
  test("names the AGENT in the sidebar, and keeps its machinery out of the row", async ({
    page,
  }) => {
    await gotoApp(page);
    // The FIRST row, and read by ID from then on. It is the row rather than a named thread
    // because the sidebar is VIRTUALIZED: a fixture whose place in the list another spec
    // decides may not be in the DOM at all, and this test is about what one row SAYS.
    const id = await openConversationAt(page, 0);
    const row = page.locator(`[data-testid="conversation-row"][data-conversation-id="${id}"]`);
    const preview = row.locator('[data-testid="conversation-preview"]');
    await optIn(page);

    // A message of the user's OWN first, so the row's "You:" is proved to be what this thread
    // shows for something they really wrote — otherwise the assertion below could pass on a
    // row that never says it at all.
    await fillComposer(page, "one moment");
    await page.keyboard.press("Enter");
    await expect(preview).toHaveText(/^You: one moment/);

    await fillComposer(page, "@claude which port is it?");
    await page.keyboard.press("Enter");
    // The answer arrives over several edits; the row follows the last of them.
    await expect(preview).toContainText("19420", { timeout: 20_000 });
    // The agent is named, the account is not, and the line the message carries for a colleague
    // reading the thread in a stock client stays out of the row.
    await expect(preview).toHaveText(/^Claude: /);
    await expect(preview).not.toContainText("You:");
    await expect(preview).not.toContainText("via teams-lite");
  });

  test("answers nothing in a conversation nobody opted in", async ({ page }) => {
    await gotoApp(page);
    // Named: the whole test is that THIS thread is off, so it cannot be a row whose
    // position another spec decides.
    await openConversationNamed(page, "Plain Text");

    await fillComposer(page, "@claude are you there?");
    await page.keyboard.press("Enter");
    // Our own message lands, and nothing answers it. `off` is the default everywhere but
    // the sandbox, and this is the gate that makes the switch mean something.
    await expect(page.locator('[data-testid="message"]').last()).toContainText(
      "are you there?",
    );
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-testid="agent-stream"]')).toHaveCount(0);
  });

  // The common shape of this feature: the user asked from their phone, and this page holds
  // the message without ever having watched the run. There is no run object here — the
  // message's own signature line says the answer is unfinished, and that is the whole of
  // what this app knows.
  test("lights the edge of a reply it never watched being written", async ({ page }) => {
    await gotoApp(page);
    const conversation = await openConversationAt(page, 0);
    await emitLive(page, {
      conversation,
      content: "",
      is_self: true,
      // `agent_policy::reply_html` mid-run: an answer, then the line that says it is still
      // being written. That line is the only thing that marks a reply (see
      // web/src/lib/agent-message.ts), so it is what the spec has to inject.
      html: "<p>The backend listens on 19420</p><p><em>claude is writing…</em></p>",
    });

    const bubble = page.locator('[data-testid="message"]', {
      has: page.locator('[data-testid="agent-signature"]'),
    });
    await expect(bubble).toBeVisible();
    // Nothing is streaming into this page, so the bubble says so in words…
    await expect(page.locator('[data-testid="agent-stream"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="agent-stalled"]')).toBeVisible();
    // …and the edge says it too, because a run this app cannot see is still a run. It is
    // the CLI's own colour, so the edge and the mark inside the bubble name one vendor.
    const shine = bubble.locator('[data-testid="agent-shine"]');
    await expect(shine).toHaveCount(1);
    await expect(shine).toHaveAttribute("data-backend", "claude");
    await expect(shine).toHaveCSS("animation-iteration-count", "infinite");

    // Held still, the sweep is a smear of colour over one corner rather than a light
    // going round an edge — so a reader who asked for less motion gets none of it, and
    // the bubble keeps the static ring it already wears.
    // The gate is CSS, so the OS query takes it away with no render in between.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(shine).toBeHidden();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(shine).toBeVisible();
  });

  // Stopping a run mid-answer. The button is on the live bubble, reachable from any client
  // watching the run — a phone included, which is the whole point, since most runs are
  // asked for from one. What it must get right: the overlay tears down like a normal
  // finish, and the message it falls back to is a SETTLED agent reply that kept the answer
  // so far — never the "still being written…" of a reply left pending, and never lost.
  test("stops a run mid-answer, keeping the answer so far", async ({ page }) => {
    await gotoApp(page);
    // Its own thread, named: this reads THE one agent reply of the history, and it ends the
    // thread OFF, so it must not land on the sandbox and take that consent from a later spec.
    await openConversationNamed(page, "Stop the Agent");
    await optIn(page);

    await fillComposer(page, "@claude which port does the backend listen on?");
    await page.keyboard.press("Enter");

    // Stop appears on the live bubble the moment the run is streaming, before the answer is
    // done — it is only useful while there is a run to stop.
    const stop = page.locator('[data-testid="agent-stop"]');
    await expect(stop).toBeVisible();
    const stream = page.locator('[data-testid="agent-stream"]');
    await expect(stream).toBeVisible();

    // Press it, and it says it is asking rather than pretending it is done: the run
    // finalizes on its own, and the terminal frame is what tears the overlay down.
    await stop.click();
    await expect(stop).toContainText("Stopping…");

    // The overlay goes, exactly as it does for a normal finish — no separate "stopped"
    // state to clean up, because a stop is a run that ended early.
    await expect(stream).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-testid="agent-status"]')).toHaveCount(0);

    // What is left is a SETTLED agent reply, not a pending one: the message kept the answer
    // so far and signed off, so it reads as finished — the `agent-stalled` bubble of a reply
    // left "still being written…" is exactly what a stop must not produce.
    const bubble = page.locator('[data-testid="message"]', {
      has: page.locator('[data-testid="agent-signature"]'),
    });
    await expect(bubble).toBeVisible();
    await expect(page.locator('[data-testid="agent-stalled"]')).toHaveCount(0);
    // The note the user reads, saying they ended it — and the run is no longer live, so the
    // edge that says "being written" is gone with the overlay.
    await expect(bubble).toContainText("stopped by you");
    await expect(bubble.locator('[data-testid="agent-shine"]')).toHaveCount(0);
    // The signature is stripped from the body (the mark says it instead), which is what
    // makes this a finished agent reply rather than the raw failure shape.
    await expect(bubble).not.toContainText("via teams-lite");

    // Leave the thread as this describe found it: OFF, so the specs that read it after do
    // not inherit a consent this test granted.
    await openConversationMenu(page);
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(conversationMenuTrigger(page)).toHaveAttribute("data-agent-mode", "off");
    await closeConversationMenu(page);
  });
});
