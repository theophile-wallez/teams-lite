// teams-lite web — what to tell the user when a call did not happen.
//
// The twin of ./send-failure.ts, for the other outward action, and it exists for the same
// reason. The backend's refusals are written for whoever is holding the socket — an
// automated driver, an ad-hoc script, a frontend — so they open with the RPC's own name
// and they name environment variables; the socket's are shorter still and name nothing at
// all. `not connected` is a real sentence this app put in front of a real user, floating
// over their chat list, and it says neither what did not happen nor what to do about it.
//
// Pure, so every sentence is unit-tested with no backend and no browser.

import { MicrophoneUnavailableError, type SendKind } from "./call-media";

/** One short sentence for a call, a join, or a capture that did not happen.
 *
 *  The fallback keeps the raw words rather than replacing them with something vague: an
 *  unrecognised failure is exactly the one the user has to be able to report. */
export function callFailureMessage(error: unknown): string {
  // The one failure that is not a bug, and the common one: the browser asks once, the user
  // says no, and every later call fails the same way until they change it in the site
  // settings. So it gets its own sentence rather than a `NotAllowedError` shown verbatim.
  if (error instanceof MicrophoneUnavailableError) {
    return "teams-lite could not open the microphone. Allow it for this site, then try again.";
  }

  const raw = rawMessage(error);

  // The socket. `not connected` / `connection closed` come from lib/ws-client.ts, and the
  // page is already showing a disconnected dot: say what it means for the call.
  if (raw === "not connected" || raw === "connection closed" || raw === "closed") {
    return "The backend is not reachable, so nothing can be called from here.";
  }
  if (raw.startsWith("timeout:")) {
    return "The backend did not answer. Try again.";
  }
  // The write lock, after a backend restart minted a new token. The client already re-read
  // the token and retried once (`retryWithAFreshToken` in lib/ws-client.ts), so reaching
  // this means the fresh one was refused too.
  if (raw.includes("needs the write token")) {
    return "This page is no longer allowed to place calls. Reload the app.";
  }
  if (raw.includes("TEAMS_LITE_READ_ONLY")) {
    return "This backend runs read-only, so no call can leave it.";
  }
  // Sign-in. The banner already says the account is unreachable; this says what that costs
  // the call (see components/broker-banner.tsx).
  if (/identity broker|acquire .*token|keyring/i.test(raw)) {
    return "Sign-in is broken, so no call can be placed from this machine yet.";
  }
  // A failure that carried no words at all. It happens — the service answers `400` with an
  // empty body (see CLAUDE.md § Joining a meeting) — and saying nothing is not an option:
  // the user pressed a button and something did not happen. It covers a call, a join and a
  // capture, so it names none of them.
  return withoutMethodName(raw) || "That did not happen, and nothing said why.";
}

/**
 * What to say when the MEETING dropped a capture the user had turned on.
 *
 * There is no error here and nothing was refused: the section was accepted and then rejected,
 * so the picture stops and the button goes off with no click behind it. Said because a camera
 * that switches itself off in silence reads as this app losing the user's input — and it names
 * the one thing left to do, which is to turn it on again.
 */
export function captureDroppedMessage(kind: SendKind): string {
  return kind === "camera"
    ? "The meeting dropped your camera, so it is off. Turn it on again."
    : "The meeting dropped your screen share, so it stopped. Share it again.";
}

/** The words an error carries, whatever shape it arrived in. Browser WebSocket and DOM
 *  failures arrive as opaque Events that stringify to a useless "[object Event]". */
function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  if (typeof Event !== "undefined" && error instanceof Event) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message ? message.trim() : "connection error";
  }
  const text = String(error).trim();
  return text.startsWith("[object ") ? "unknown error" : text;
}

/**
 * Drop the RPC's own name off the front of a backend refusal.
 *
 * The backend opens each one with the method it refused (`call_prepare: calling is not
 * connected yet — turn it on in Settings`), which is right for its reader and wrong for
 * this one: `call_offer_media` is not something the user can act on, and it reads as a
 * fault code in front of a plain sentence. The rest of the sentence is kept word for word.
 *
 * The name must be followed by whitespace or be the whole of it, which is what leaves a
 * URL's `https://` and a time's `10:30` alone — and a refusal that is NOTHING but the
 * name comes back empty, so the caller's own fallback says something instead of handing
 * the user a bare `call_join:`.
 */
function withoutMethodName(raw: string): string {
  const named = /^[a-z][a-z0-9_]*:(\s+|$)/.exec(raw);
  return named ? raw.slice(named[0].length) : raw;
}
