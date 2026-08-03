// Desktop notifications for incoming messages, via the browser Notification API.
//
// A thin, best-effort side-effect layer: it never throws, and the decision of
// *whether* to notify lives in the caller (see shouldNotify in ./protocol).

/** Ask for notification permission once, lazily. Safe to call repeatedly. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

/**
 * Fire a desktop notification for an incoming message. No-op if notifications
 * are unavailable or not granted. Never throws. Returns the Notification so the
 * caller can wire a click handler (e.g. focus the conversation).
 *
 * `body` is already PLAIN text: how a message body is read depends on its Teams
 * `messagetype` (a `Text` body is not HTML — see `bodyFormat`), and that decision
 * belongs to the caller, which has the whole message. Stripping tags here would eat
 * the angle brackets out of a plain body all over again.
 */
export function notifyMessage(sender: string, body: string): Notification | null {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const title = sender && sender.length > 0 ? sender : "New message";
  try {
    return new Notification(title, { body, tag: "teams-lite", silent: false });
  } catch {
    return null;
  }
}

/**
 * Fire a desktop notification for an incoming call. Awareness only: teams-lite
 * has no media stack, so this just tells the user a call is ringing — clicking it
 * can focus the conversation, but the call can only be answered in Microsoft
 * Teams. `label` is the group/channel name (omit for a 1:1). No-op if
 * notifications are unavailable or not granted. Never throws.
 */
export function notifyCall(caller: string, label?: string): Notification | null {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const who = caller && caller.length > 0 ? caller : "Someone";
  const body = label && label.length > 0 ? `${who} · ${label}` : `${who} is calling`;
  try {
    return new Notification("Incoming call", { body, tag: "teams-lite-call", silent: false });
  } catch {
    return null;
  }
}
