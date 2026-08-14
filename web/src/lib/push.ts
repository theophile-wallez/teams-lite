// The browser half of push notifications: work out whether this device can receive
// them, and register it with the backend.
//
// The point of the feature is a phone: an installed web app that is CLOSED still
// gets told when somebody writes. In-page notifications (see ./notify.ts) cannot do
// that — they need a live tab — so this path goes through a service worker and the
// operating system instead. The backend does the sending (src/push.rs).
//
// iOS is the constraining platform, and it has two rules the desktop does not:
//
//   1. **Only an installed web app can subscribe.** In a Safari TAB, `Notification`
//      and `PushManager` are absent; they appear once the page has been added to the
//      Home Screen and opened from there. So "unsupported" and "not installed yet"
//      are different answers, and the UI has to be able to tell the user which.
//   2. **Permission must be asked from a user gesture.** Calling
//      `Notification.requestPermission()` on load is refused outright, which is why
//      nothing here runs on its own — it all hangs off the Settings button.
//
// Everything that can be a pure function is one, so the decision table is unit
// tested rather than inferred from a phone.

/** One subscribed device, as the backend reports it. */
export type PushDevice = {
  endpoint: string;
  label: string;
  created_ms: number;
  last_ok_ms: number;
  last_error: string;
};

/** The backend's push state: whether it can push at all, its VAPID public key (the
 *  `applicationServerKey` a subscription is bound to), and the known devices. */
export type PushStatus = {
  supported: boolean;
  reason?: string;
  public_key: string;
  devices: PushDevice[];
};

/** What this browser can do about notifications, as observed. */
export type PushEnvironment = {
  /** Service worker + Push API + Notification API all present. */
  capable: boolean;
  /** Running as an installed app (Home Screen / standalone window). */
  installed: boolean;
  /** An Apple mobile browser, where push exists only for an installed app. Used to
   *  turn "capable: false" into advice instead of a dead end. */
  appleMobile: boolean;
  /** A secure context (`https:`, or a loopback host). Every API push needs is absent
   *  without one, so this is the difference between "your browser cannot" and "this
   *  address cannot" — see {@link pushBlocker}. */
  secure: boolean;
  /** The Notification permission, or "unavailable" where the API is absent. */
  permission: NotificationPermission | "unavailable";
};

/** Why this device cannot receive push notifications, or `null` when it can. */
export type PushBlocker =
  /** The page is on an insecure origin, where no browser publishes any of this. Open
   *  the app over HTTPS, or on loopback. */
  | "insecure"
  /** iOS: add the page to the Home Screen and open it from there. */
  | "needs-install"
  /** The browser has no Push API at all. */
  | "unsupported"
  /** The user said no. Only the OS settings can undo that. */
  | "denied"
  /** The backend does not push (read-only mode). */
  | "backend"
  | null;

/** What Settings shows, resolved from the browser and the backend together. */
export type PushState = {
  environment: PushEnvironment;
  blocker: PushBlocker;
  /** This device's endpoint when it is subscribed, else null. */
  endpoint: string | null;
  /** Every subscribed device, so a phone can see the laptop is registered too. */
  devices: PushDevice[];
  /** A request is in flight (subscribe / unsubscribe / test). */
  busy: boolean;
  /** The last failure, for the pane to show. */
  error: string | null;
};

export const INITIAL_PUSH_STATE: PushState = {
  environment: {
    capable: false,
    installed: false,
    appleMobile: false,
    secure: true,
    permission: "unavailable",
  },
  blocker: "unsupported",
  endpoint: null,
  devices: [],
  busy: false,
  error: null,
};

/** The service worker's scope and file. Served straight from `public/`, so the
 *  scope is the whole app (a worker can only control its own directory downwards). */
export const SERVICE_WORKER_URL = "/sw.js";

/**
 * Read what this browser supports. Pure with respect to its inputs (both injected)
 * so the decision table below is testable without a real browser.
 */
export function readPushEnvironment(
  nav: Partial<Navigator> & { standalone?: boolean } = typeof navigator === "undefined"
    ? ({} as Navigator)
    : (navigator as Navigator & { standalone?: boolean }),
  win: Partial<Window> = typeof window === "undefined" ? ({} as Window) : window,
): PushEnvironment {
  const hasNotification = typeof (win as { Notification?: unknown }).Notification === "function";
  const capable = Boolean(
    nav.serviceWorker &&
      typeof (win as { PushManager?: unknown }).PushManager === "function" &&
      hasNotification,
  );
  // `navigator.standalone` is Safari's own flag for "launched from the Home
  // Screen"; the media query is the standard one every other browser answers.
  const standaloneMedia = win.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  const installed = Boolean(nav.standalone) || standaloneMedia;
  // iPhone/iPad, including an iPad that reports itself as a Mac with touch.
  const ua = nav.userAgent ?? "";
  const appleMobile =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  const permission = hasNotification
    ? ((win as { Notification: { permission: NotificationPermission } }).Notification.permission)
    : ("unavailable" as const);
  // `isSecureContext` is the browser's own answer, and it is the only one worth asking:
  // it already knows that loopback counts and that a tailnet HTTPS front does too, which
  // a rule written over `location` here would have to re-derive and get wrong. Absent (an
  // ancient browser, a stub in a test) reads as SECURE, because the capability check
  // below is what really decides — this flag only chooses which sentence explains it.
  const secure = (win as { isSecureContext?: boolean }).isSecureContext !== false;
  return { capable, installed, appleMobile, secure, permission };
}

/**
 * The one thing standing between this device and notifications, or `null`.
 *
 * ORDER IS THE WHOLE OF THIS FUNCTION, because every cause below arrives as the same
 * symptom — `capable: false`, the APIs simply missing — and what differs is the reader's
 * next move. A backend that never pushes makes every browser question moot. An INSECURE
 * ORIGIN comes next: no browser publishes `serviceWorker` or `PushManager` without a
 * secure context, so a page opened over plain `http://` at a hostname or a LAN address
 * (a tailnet name without TLS, `http://192.168…`) reported "this browser cannot receive
 * push notifications" — which is false about the browser, blames the wrong thing, and
 * hides the one-step fix. It is the mistake `needs-install` already exists to avoid, in
 * the other direction, and it happened to a real reader on Brave. HTTPS beats the Apple
 * branch, since an iOS page over `http` cannot be installed either.
 */
export function pushBlocker(environment: PushEnvironment, backendSupports: boolean): PushBlocker {
  if (!backendSupports) return "backend";
  if (!environment.capable) {
    if (!environment.secure) return "insecure";
    return environment.appleMobile && !environment.installed ? "needs-install" : "unsupported";
  }
  if (environment.permission === "denied") return "denied";
  return null;
}

/** A sentence for each blocker, so the pane never has to guess the wording. */
export function pushBlockerMessage(blocker: PushBlocker, reason?: string): string | null {
  switch (blocker) {
    case "insecure":
      return "Notifications need a secure connection, and this page is on plain http:// — no browser offers them there. Open teams-lite over https, or at http://127.0.0.1 on the machine it runs on.";
    case "needs-install":
      return "On iPhone and iPad, notifications need the app on your Home Screen. Tap Share, then “Add to Home Screen”, and open teams-lite from there.";
    case "unsupported":
      return "This browser cannot receive push notifications.";
    case "denied":
      return "Notifications are blocked for this app. Allow them in your device settings, then try again.";
    case "backend":
      return reason ?? "This backend does not send push notifications.";
    default:
      return null;
  }
}

/** What the sidebar says about notifications, or `null` for nothing at all. */
export type PushOffer =
  /** This device can subscribe and has not: offer the switch. */
  | "enable"
  /** iOS in a tab, where the fix is Share → Add to Home Screen. */
  | "install"
  /** A page on plain http://, where the fix is the address. */
  | "insecure"
  | null;

/**
 * Whether the sidebar offers notifications, and in which of its two shapes.
 *
 * The feature was complete and nobody had it on: measured on this machine's own store,
 * ZERO devices were subscribed while the switch had sat in Settings for a fortnight. A
 * setting nobody finds is a feature that does not exist — so the offer comes to the
 * reader once, where they already look, and the Settings section stays the place they
 * turn it back off.
 *
 * SILENT on `denied`, `unsupported` and `backend`, and that is the whole reason this is a
 * function rather than a `!endpoint` check: a row the reader cannot act on is a nag. Each
 * of those three is undone somewhere this app cannot reach — the OS settings, another
 * browser, a backend started read-only — and Settings › Notifications already says which.
 * `INITIAL_PUSH_STATE` is `unsupported` too, so nothing is offered before the backend has
 * answered: a row that appeared and then took itself back is worse than one beat of
 * silence.
 *
 * The two blockers it DOES speak for are the two the reader can undo themselves: an iOS
 * tab (add it to the Home Screen) and an insecure address (open it over https). Both are a
 * sentence rather than a button, because there is no press here that could work.
 */
export function pushOffer(state: PushState, dismissed: boolean): PushOffer {
  if (dismissed) return null;
  // On here already. The list of OTHER devices is Settings' business, not a row's.
  if (state.endpoint !== null) return null;
  switch (state.blocker) {
    case null:
      return "enable";
    case "needs-install":
      return "install";
    case "insecure":
      return "insecure";
    default:
      return null;
  }
}

/**
 * Decode a base64url VAPID key into the bytes `pushManager.subscribe` wants.
 *
 * It insists on a `BufferSource`, not the string the backend sends, and every
 * browser is strict about the padding — hence a helper rather than an inline
 * `atob`.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(base64);
  // Backed by a plain ArrayBuffer, not a SharedArrayBuffer: `subscribe` wants a
  // BufferSource, and only the narrow type satisfies it.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode a subscription key (raw bytes) the way the backend stores it. */
export function bytesToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The subscription in the shape the backend's `push_subscribe` expects. */
export type SubscriptionPayload = { endpoint: string; p256dh: string; auth: string; label: string };

/** Pull the two keys out of a `PushSubscription`; null when the browser gave us a
 *  subscription without them (which cannot be encrypted to, so it is unusable). */
export function subscriptionPayload(
  subscription: PushSubscription,
  label: string,
): SubscriptionPayload | null {
  const p256dh = subscription.getKey?.("p256dh");
  const auth = subscription.getKey?.("auth");
  if (!p256dh || !auth) return null;
  return {
    endpoint: subscription.endpoint,
    p256dh: bytesToBase64Url(p256dh),
    auth: bytesToBase64Url(auth),
    label,
  };
}

/**
 * A short name for this device, so the Settings list reads "iPhone · Safari" rather
 * than four lines of user agent. Best-effort and cosmetic: the endpoint is the
 * identity, this is only the label next to it.
 */
export function deviceLabel(
  nav: Partial<Navigator> = typeof navigator === "undefined" ? ({} as Navigator) : navigator,
): string {
  const ua = nav.userAgent ?? "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Device";
  // Order matters: every Chromium claims Safari, and Edge claims Chrome.
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${device} · ${browser}`;
}

// ---- the imperative half -------------------------------------------------------

/**
 * Register the service worker, and wait until it is actually active.
 *
 * Waiting matters: `pushManager.subscribe` on a registration whose worker is still
 * installing fails, and the first launch after an install is exactly when the user
 * taps Enable.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    // A worker that will not register (no HTTPS, a blocked scope) leaves push
    // unavailable; the pane already says so through the blocker.
    return null;
  }
}

/** This device's existing subscription, or null. Never throws. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask for permission and subscribe this device.
 *
 * MUST be called from a user gesture — iOS refuses the permission prompt otherwise.
 * Throws with a readable message, because the caller is a button that has to say
 * what went wrong.
 */
export async function subscribeThisDevice(publicKey: string): Promise<SubscriptionPayload> {
  const registration = await registerServiceWorker();
  if (!registration) throw new Error("this browser could not start the notification worker");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notifications were not allowed on this device");

  // Re-use an existing subscription when it is bound to the same key; a key change
  // (a rebuilt backend) means the old one can no longer be pushed to, so it is
  // dropped and replaced.
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const boundTo = existing.options?.applicationServerKey;
    const sameKey =
      boundTo instanceof ArrayBuffer && bytesToBase64Url(boundTo) === publicKey.replace(/=+$/, "");
    if (sameKey) {
      const payload = subscriptionPayload(existing, deviceLabel());
      if (payload) return payload;
    }
    await existing.unsubscribe().catch(() => {});
  }

  const subscription = await registration.pushManager.subscribe({
    // Required, and true in fact: every push this app sends shows a notification
    // (see public/sw.js).
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  const payload = subscriptionPayload(subscription, deviceLabel());
  if (!payload) throw new Error("the browser returned a subscription without encryption keys");
  return payload;
}

/** Drop this device's subscription in the browser. Returns the endpoint that was
 *  removed so the caller can tell the backend to forget it too. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => {});
  return endpoint;
}
