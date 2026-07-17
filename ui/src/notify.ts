// Desktop notifications for incoming messages.
//
// This is a thin, isolated side-effect layer: it turns an incoming message into
// a Linux desktop notification via `notify-send` (libnotify). It holds no UI or
// business logic — the decision of *whether* to notify lives in the caller.

const APP_NAME = "teams-lite";

// Resolved once: whether `notify-send` is available on this system. We probe
// lazily on the first notify() call and cache the result so a missing binary
// degrades gracefully (no notifications) instead of throwing on every message.
let available: boolean | null = null;

async function probe(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["notify-send", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/// Strip HTML tags and decode the handful of entities Teams emits, so the
/// notification body reads as plain text. Mirrors the UI's display cleanup.
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/// Pure decision: should an incoming message raise a desktop notification?
/// We never notify our own messages, nor a message for the conversation the
/// user is currently looking at. Kept side-effect-free so it is unit-testable.
export function shouldNotify(
  msg: { conversation_id: string; is_self?: boolean },
  openConversationId: string | null,
): boolean {
  if (msg.is_self) return false;
  if (openConversationId !== null && msg.conversation_id === openConversationId) return false;
  return true;
}

/// Fire a desktop notification for an incoming message. No-op (best effort) if
/// `notify-send` is not installed. Never throws — a failed notification must not
/// break the message flow.
export async function notifyMessage(sender: string, content: string): Promise<void> {
  if (available === null) available = await probe();
  if (!available) return;

  const title = sender && sender.length > 0 ? sender : "New message";
  const body = plainText(content);
  try {
    Bun.spawn(
      ["notify-send", "--app-name", APP_NAME, "--", title, body],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    // ignore: a notification failure is never worth surfacing to the user
  }
}
