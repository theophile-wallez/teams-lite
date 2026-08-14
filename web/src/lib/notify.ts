// The notification a LIVE page shows — the other half of Web Push (see ./push.ts).
//
// Push covers an app that is closed; this covers one that is open but not being looked
// at, which is most of a working day: the service worker deliberately shows nothing
// while a window is visible (see public/sw.js), so the page owes the reader the popup
// itself. Whether a message deserves one is decided by `shouldNotify` in ./protocol —
// this file only shows it, never throws, and does nothing at all without permission.
//
// TWO WAYS TO SHOW ONE, and the second is not a nicety: an installed web app on iOS has
// `window.Notification` (its `permission` and `requestPermission` both work) and REFUSES
// the constructor — WebKit only notifies through the service worker registration there.
// So the constructor is tried and its failure is a route rather than an outcome, which
// is what makes a popup on the user's phone possible while their app is open.
//
// NOTHING HERE ASKS FOR PERMISSION. It used to be asked on connect, out of nowhere: a
// prompt with no question in front of it is dismissed, and a browser that has been
// dismissed a few times stops asking and answers `denied` — which is the one state
// neither this app nor its Settings pane can undo. Permission is asked by the switch the
// reader pressed (`subscribeThisDevice` in ./push.ts), from their own gesture, which is
// also the only shape iOS accepts.

/** Show one notification, whichever way this browser allows. Best-effort throughout:
 *  a browser with no Notification API, a reader who never allowed them, and a worker
 *  that will not register each cost the popup and nothing else. */
async function show(title: string, options: NotificationOptions): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, options);
    return;
  } catch {
    // iOS: `new Notification` is an illegal constructor inside an installed web app.
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration("/");
    await registration?.showNotification(title, options);
  } catch {
    // No worker registered on this device (notifications were never turned on here).
  }
}

/**
 * Tell the reader somebody wrote, and where.
 *
 * `body` is already PLAIN text: how a message body is read depends on its Teams
 * `messagetype` (a `Text` body is not HTML — see `bodyFormat`), and that decision
 * belongs to the caller, which has the whole message. Stripping tags here would eat
 * the angle brackets out of a plain body all over again.
 *
 * `conversationId` is what a TAP opens, and it travels as the same `data.url` a push
 * carries (`push_policy::notification_for` writes that very path) so `notificationclick`
 * in public/sw.js needed no second case. Fire-and-forget: a popup is never something the
 * history waits on.
 */
export function notifyMessage(sender: string, body: string, conversationId?: string): void {
  const title = sender && sender.length > 0 ? sender : "New message";
  void show(title, {
    body,
    // One row per conversation, replacing itself: the rule the push path already holds.
    tag: conversationId ? `teams-lite-${conversationId}` : "teams-lite",
    silent: false,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: conversationId ? `/c/${encodeURIComponent(conversationId)}` : "/" },
  });
}

/**
 * Tell the reader a call is ringing. `label` is the group/channel name (omit for a
 * 1:1). Awareness only — the call is answered on the app's own ringing card, which is
 * what a tap brings the reader to.
 */
export function notifyCall(caller: string, label?: string, conversationId?: string): void {
  const who = caller && caller.length > 0 ? caller : "Someone";
  const body = label && label.length > 0 ? `${who} · ${label}` : `${who} is calling`;
  void show("Incoming call", {
    body,
    tag: "teams-lite-call",
    silent: false,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: conversationId ? `/c/${encodeURIComponent(conversationId)}` : "/" },
  });
}
