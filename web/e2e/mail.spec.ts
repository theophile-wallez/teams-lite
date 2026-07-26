import {
  test,
  expect,
  gotoApp,
  openMailTab,
  openMailAt,
  emitMail,
  fetchTestMail,
  realErrors,
} from "./helpers";

// Mail is a third first-class sidebar surface next to Chats and Channels, backed by
// the same local-first pipeline and the same WebSocket — and strictly READ-ONLY.
//
// These specs cover the flow end to end (tab → folder → list → reading pane →
// attachments → live delivery) and, just as importantly, the two properties that
// make a mail client safe to point at a real mailbox:
//
//   - a mail body cannot reach the network: no remote image is ever loaded, so
//     opening a message tells its sender nothing;
//   - a mail body cannot script: the frame it renders in has no `allow-scripts`.
//
// Both are asserted here rather than trusted, because both are invisible when they
// silently regress.
test.describe("mail", () => {
  test("has a Mail tab that reveals the mailbox", async ({ page }) => {
    await gotoApp(page);

    await expect(page.locator('[data-testid="tab-mail"]')).toBeVisible();
    // Mail is lazy: nothing is loaded until the tab is opened.
    await expect(page.locator('[data-testid="mail-row"]')).toHaveCount(0);

    await openMailTab(page);

    // The mail list replaces the chat list (the inactive panel is unmounted).
    await expect(page.locator('[data-testid="sidebar-scroll"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mail-scroll"]')).toBeVisible();
    expect(await page.locator('[data-testid="mail-row"]').count()).toBeGreaterThan(3);
  });

  test("selects the inbox by default and can switch folders", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);

    // The inbox is chosen automatically, under its stable English label rather than
    // the mailbox's localized display name ("Boîte de réception").
    const picker = page.locator('[data-testid="mail-folder-picker"]');
    await expect(picker).toContainText("Inbox");

    const { folders } = await fetchTestMail(page);
    const sent = folders.find((f) => f.well_known === "Sent");
    expect(sent).toBeTruthy();

    await picker.click();
    await page.locator(`[data-testid="mail-folder-option"][data-folder-id="${sent!.id}"]`).click();
    await expect(picker).toContainText("Sent");
    // The list follows the folder.
    await expect
      .poll(() => page.locator('[data-testid="mail-row"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test("badges the inbox's unread count on the tab", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);

    const { folders } = await fetchTestMail(page);
    const inbox = folders.find((f) => f.well_known === "Inbox")!;
    expect(inbox.unread_count).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="mail-unread-badge"]')).toHaveText(
      String(inbox.unread_count),
    );
  });

  test("opens a mail into the reading pane", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);

    const subject = (
      (await page.locator('[data-testid="mail-row"]').first().locator('[data-testid="mail-subject"]').textContent()) ?? ""
    ).trim();
    const id = await openMailAt(page, 0);

    // The pane shows the mail, and the URL owns which one is open.
    await expect(page.locator('[data-testid="mail-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="mail-heading"]')).toHaveText(subject);
    await expect(page.locator('[data-testid="mail-from"]')).not.toBeEmpty();
    expect(page.url()).toContain(encodeURIComponent(id));
    // And the row it came from is marked as the open one.
    await expect(page.locator(`[data-mail-id="${id}"]`)).toHaveAttribute("data-open", "true");
  });

  test("a mail body loads no remote content and cannot script", async ({ page }) => {
    // THE spec for this feature. A mail body is a foreign document: the backend
    // sanitizes it (src/mail_html.rs) and the frame isolates it (mail-body.tsx).
    await gotoApp(page);
    await openMailTab(page);

    // Watch for any request the page makes while the mail renders. A tracking pixel
    // would show up here as a request to an external host.
    const external: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (!url.startsWith("http://127.0.0.1") && !url.startsWith("data:")) external.push(url);
    });

    await openMailAt(page, 0);
    const frame = page.locator('[data-testid="mail-body"]');
    await expect(frame).toBeVisible();

    // The sandbox must NOT grant scripts: that single omission is what makes the
    // frame inert whatever survived sanitizing.
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");

    // The document carries its own CSP, allowing images only as data: URIs.
    const csp = await frame.contentFrame().locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");

    // No image inside the body points anywhere but at embedded data.
    const sources = await frame.contentFrame().locator("img").evaluateAll((imgs) =>
      imgs.map((img) => img.getAttribute("src") ?? ""),
    );
    for (const src of sources) {
      expect(src === "" || src.startsWith("data:")).toBeTruthy();
    }

    // And nothing left the machine.
    expect(external).toEqual([]);
  });

  test("says how many remote images it refused to load", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);
    // The first fixture is a newsletter whose remote images were all blocked.
    await openMailAt(page, 0);

    const notice = page.locator('[data-testid="mail-blocked-images"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("remote");
    // The reason is stated, not just the count — that is the point of the notice.
    await expect(notice).toContainText("sender");
  });

  test("renders the body's own layout and embedded inline images", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);
    // The second fixture carries a table layout, a quote, and an inline image the
    // backend embedded as a data URI.
    await openMailAt(page, 1);

    const body = page.locator('[data-testid="mail-body"]').contentFrame();
    await expect(body.locator("blockquote")).toBeVisible();
    const inline = body.locator("img");
    await expect(inline.first()).toBeVisible();
    expect(await inline.first().getAttribute("src")).toContain("data:image/");
  });

  test("lists file attachments but not the inline ones", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);
    await openMailAt(page, 1);

    const chips = page.locator('[data-testid="mail-attachment"]');
    // The fixture has two files plus one inline image; the inline one is already
    // rendered in the body, so listing it again would double it up.
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText("platform-review-q3.pdf");
    await expect(chips.first()).toContainText("MB");
    await expect(page.locator('[data-testid="mail-attachments"]')).not.toContainText("logo.svg");
  });

  test("shows a new mail as it arrives", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);

    const subject = `Live delivery ${Date.now()}`;
    await emitMail(page, { subject, sender: "Riley Carter", preview: "Just landed." });

    // It appears at the top of the list, unread, without a reload.
    const row = page.locator('[data-testid="mail-row"]', { hasText: subject });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toHaveAttribute("data-unread", "true");
  });

  test("keeps a deep link to a mail across a reload", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);
    const id = await openMailAt(page, 2);
    const heading = (await page.locator('[data-testid="mail-heading"]').textContent()) ?? "";

    await page.reload();

    // The URL is the source of truth, so the mail re-opens on its own — even though
    // the sidebar starts back on the Chats tab.
    await expect(page.locator('[data-testid="mail-heading"]')).toHaveText(heading);
    expect(page.url()).toContain(encodeURIComponent(id));
  });

  test("pages further back as the list is scrolled", async ({ page }) => {
    await gotoApp(page);
    await openMailTab(page);

    // The inbox holds more mail than one page, so something beyond the first page
    // exists to reach. Note the list is virtualized: the number of ROWS in the DOM
    // stays roughly constant however much data is loaded, so the assertion has to
    // be "a specific mail from deeper than page one is reachable", not "more rows".
    const { inbox } = await fetchTestMail(page);
    expect(inbox.length).toBeGreaterThan(45);
    const deep = inbox[45]!;

    const scroller = page.locator('[data-testid="mail-scroll"]');
    // Mail pages into the PAST as you scroll down, the opposite of a chat history.
    for (let i = 0; i < 8; i++) {
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(250);
      if (await page.locator(`[data-mail-id="${deep.id}"]`).count()) break;
    }
    await expect(page.locator(`[data-mail-id="${deep.id}"]`)).toBeVisible();
  });

  test("offers no way to send, reply to, or delete a mail", async ({ page }) => {
    // The mailbox is the user's personal account and this app cannot write to it —
    // the backend has no such path at all. The UI must not imply otherwise.
    await gotoApp(page);
    await openMailTab(page);
    await openMailAt(page, 0);

    const pane = page.locator('[data-testid="mail-pane"]');
    await expect(pane).toContainText("read-only");
    for (const label of [/^reply/i, /^forward/i, /^delete/i, /^send/i, /^archive/i]) {
      await expect(pane.getByRole("button", { name: label })).toHaveCount(0);
    }
    // No composer either: that belongs to chat, which has consent rules of its own.
    await expect(pane.locator('[data-testid="composer"]')).toHaveCount(0);
  });

  test("leaves the chat surfaces untouched", async ({ page }) => {
    // Mail must not leak into the conversation list, exactly as channels must not.
    await gotoApp(page);
    const chats = await page.locator('[data-testid="conversation-row"]').count();
    await openMailTab(page);
    const { inbox } = await fetchTestMail(page);
    const mailIds = new Set(inbox.map((m) => m.id));

    await page.locator('[data-testid="tab-chats"]').click();
    await expect(page.locator('[data-testid="sidebar-scroll"]')).toBeVisible();
    expect(await page.locator('[data-testid="conversation-row"]').count()).toBe(chats);
    const ids = await page
      .locator('[data-testid="conversation-row"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-conversation-id") ?? ""));
    for (const id of ids) expect(mailIds.has(id)).toBeFalsy();
  });

  test("runs clean with no console errors", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openMailTab(page);
    await openMailAt(page, 1);
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
