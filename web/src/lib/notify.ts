// Desktop notifications for incoming messages, via the browser Notification API.
//
// The web analog of ui/src/notify.ts (which shells out to notify-send). It is a
// thin, best-effort side-effect layer: it never throws, and the decision of
// *whether* to notify lives in the caller (see shouldNotify in ./protocol).

import { plain } from "./protocol";

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
 */
export function notifyMessage(sender: string, content: string): Notification | null {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const title = sender && sender.length > 0 ? sender : "New message";
  const body = plain(content);
  try {
    return new Notification(title, { body, tag: "teams-lite", silent: false });
  } catch {
    return null;
  }
}
