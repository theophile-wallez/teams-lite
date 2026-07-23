import { test as base, expect, type Page } from "@playwright/test";

// A test fixture that tracks browser console errors and page errors, so specs
// can assert the app runs clean. Favicon 404s and the React devtools notice are
// filtered out as noise.
type Fixtures = {
  consoleErrors: string[];
};

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
  },
});

export { expect };

/** Navigate to the app and wait until it has connected and loaded conversations. */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  // The sidebar renders conversation rows once the WebSocket handshake completes
  // and `conversations` returns — a reliable "app is live" signal.
  await expect
    .poll(() => page.locator('[data-testid="conversation-row"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(3);
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

/** Inject a live message through the mock's gated test hook. */
export async function emitLive(
  page: Page,
  body: { conversation: string; content: string; sender?: string; is_self?: boolean; reply?: boolean },
): Promise<void> {
  const mockPort = process.env.E2E_MOCK_PORT ?? "8420";
  const res = await page.request.post(`http://127.0.0.1:${mockPort}/__test/emit`, { data: body });
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
  const mockPort = process.env.E2E_MOCK_PORT ?? "8420";
  const res = await page.request.post(`http://127.0.0.1:${mockPort}/__test/emit`, {
    data: { kind: "notification", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Broadcast a typing/presence signal through the mock's gated test hook. */
export async function emitTyping(
  page: Page,
  body: { conversation: string; sender?: string; sender_mri?: string; is_typing?: boolean },
): Promise<void> {
  const mockPort = process.env.E2E_MOCK_PORT ?? "8420";
  const res = await page.request.post(`http://127.0.0.1:${mockPort}/__test/emit`, {
    data: { kind: "typing", ...body },
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
  const mockPort = process.env.E2E_MOCK_PORT ?? "8420";
  const res = await page.request.post(`http://127.0.0.1:${mockPort}/__test/emit`, {
    data: { kind: "reaction", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Filter out benign console noise so `consoleErrors` only holds real problems. */
export function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon/i.test(e) && !/Download the React DevTools/i.test(e) && !/404/.test(e),
  );
}
