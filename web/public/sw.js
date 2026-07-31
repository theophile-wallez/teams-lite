// The service worker — the only part of the app that runs while the app is closed.
//
// It exists for ONE job: receive a Web Push and show a notification. On iOS that is
// the only way a Home Screen web app can be told anything while it is not open, and
// it is why teams-lite is usable as a phone app at all (see src/push.rs for the
// sending half).
//
// Deliberately NOT a cache: no `fetch` handler, no precache, no offline shell. This
// app is a live client of a backend on the user's own machine; a cached shell would
// let it start up showing a build the user replaced weeks ago, and the failure mode
// (a stale app that looks current) is worse than the failure it would prevent (a
// blank page while the machine is unreachable — which the app itself explains).
//
// Hand-written and served straight from public/, so what runs in the browser is what
// is in the repo: no bundler, no generated worker, nothing to diff against.

// Same shape as `push::Notification` in the Rust backend.
/** @typedef {{title: string, body: string, url: string, tag: string}} PushPayload */

self.addEventListener("install", () => {
  // Take over from the previous worker immediately. There is no cache to migrate,
  // and a push arriving during a hand-over should not fall between two workers.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

/**
 * Show one notification for an incoming push.
 *
 * A push whose payload will not parse still shows something: the platform expects a
 * visible notification for every push it delivered (`userVisibleOnly`), and a silent
 * drop is what makes a browser revoke the subscription.
 */
async function handlePush(event) {
  /** @type {PushPayload} */
  let payload = { title: "teams-lite", body: "New activity", url: "/", tag: "teams-lite" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Keep the generic payload above.
  }

  // If a window is open AND on screen, the app itself is already showing this
  // message in the conversation, and its in-page notification path has handled it
  // (see src/lib/notify.ts). Telling the user twice is worse than not telling them.
  // This is also the one case where a platform tolerates a push that shows nothing:
  // the user can see the update.
  if (await hasVisibleClient()) return;

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    // Both are the app icon: `icon` is the notification's own image, `badge` the
    // monochrome glyph Android puts in the status bar. iOS uses the app's icon.
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // One row per conversation: a burst replaces itself instead of stacking.
    tag: payload.tag,
    // Replacing a notification should not re-alert — the phone already buzzed for
    // the first message of the burst.
    renotify: false,
    // Where a tap goes.
    data: { url: payload.url },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openConversation(event.notification.data?.url || "/"));
});

/**
 * Focus the app on the conversation the notification came from: reuse an open
 * window when there is one (a phone that was merely backgrounded), else start one.
 */
async function openConversation(url) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if ("focus" in client) {
      await client.focus();
      // Navigating an existing client keeps the app's state (and its WebSocket)
      // instead of reloading the whole app.
      if ("navigate" in client) await client.navigate(url).catch(() => {});
      return;
    }
  }
  await self.clients.openWindow(url);
}

/**
 * Subscriptions expire, and the browser rotates them. When that happens the old
 * endpoint is dead and the backend must be told about the new one — which needs the
 * app's own authenticated socket, so the page does it on its next launch
 * (`syncPushSubscription` in src/lib/push.ts). All this worker can do is make sure
 * a fresh subscription EXISTS to be picked up.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  try {
    await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    // Nothing more to try from here; the page repairs it on the next launch.
  }
}

/** Whether one of this app's windows is open and on screen right now. */
async function hasVisibleClient() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clients.some((client) => client.visibilityState === "visible");
}
