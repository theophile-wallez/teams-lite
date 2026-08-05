// teams-lite web — what to tell the user when a message did not leave.
//
// A failed send is the one failure this app must never swallow: the user pressed the
// button, the words are still in the box, and everybody they wrote to saw nothing. It
// used to be reported by the status line alone — eleven truncated pixels at the foot of
// the sidebar, which on a phone is not on screen at all — so the whole event read as a
// button that chimed and did nothing.
//
// The backend's own refusals are written for whoever is holding the socket (an ad-hoc
// script, an automated driver, a frontend), so they are long and they name environment
// variables. This turns each one into a sentence for the person who pressed Send: what
// did not happen, and what they can do about it. Pure, so it is unit-tested without a
// backend.

/** Where the message went: nowhere. Every sentence starts here, because that is the
 *  fact — the rest is why. */
const PREFIX = "Not sent";

/**
 * One short sentence for a failed `send`, from the raw error the backend (or the socket)
 * gave us.
 *
 * The fallback keeps the raw text rather than replacing it with something vague: an
 * unrecognised failure is exactly the one the user has to be able to report.
 */
export function sendFailureMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();

  // The write lock, after a backend restart minted a new token. The client re-reads the
  // token and retries once on its own (see `retryWithAFreshToken` in lib/ws-client.ts),
  // so reaching this text means the fresh one was refused too — and a reload is then the
  // one thing left for the user to try.
  if (raw.includes("needs the write token")) {
    return `${PREFIX} — this page is no longer allowed to write. Reload the app.`;
  }
  // A read-only backend. Nothing the user does in the page changes it.
  if (raw.includes("TEAMS_LITE_READ_ONLY")) {
    return `${PREFIX} — this backend runs read-only, so nothing can leave it.`;
  }
  // The socket. `not connected` / `connection closed` come from lib/ws-client.ts, and
  // the page is already showing a disconnected dot: say what it means for the message.
  if (raw === "not connected" || raw === "connection closed" || raw === "closed") {
    return `${PREFIX} — the backend is not reachable. It will not leave until it is.`;
  }
  if (raw.startsWith("timeout:")) {
    return `${PREFIX} — the backend did not answer. Try again.`;
  }
  // Sign-in. The banner already says the account is unreachable; this says what that
  // costs the message in the box (see broker-banner.tsx).
  if (/identity broker|acquire .*token|keyring/i.test(raw)) {
    return `${PREFIX} — sign-in is broken, so nothing can leave this machine yet.`;
  }
  return raw ? `${PREFIX} — ${raw}` : `${PREFIX}.`;
}
