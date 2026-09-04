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

import { CaptureUnavailableError, MicrophoneUnavailableError, type SendKind } from "./call-media";

/** One short sentence for a call, a join, or a capture that did not happen.
 *
 *  The fallback keeps the raw words rather than replacing them with something vague: an
 *  unrecognised failure is exactly the one the user has to be able to report. */
export function callFailureMessage(error: unknown): string {
  // THE ADDRESS, not a refusal, and the order matters for the reason `pushBlocker`'s does:
  // both arrive as one failed open, and only this flag tells them apart. On a page reached
  // over plain http:// there is no `navigator.mediaDevices` at all, so "Allow it for this
  // site" sent the reader into permissions that were never the cause and could never be the
  // fix — measured on Brave over NetBird. See ./push.ts, whose Settings remedy carries the
  // flag's own name; a notice has room for the two fixes and not for a paragraph.
  if (error instanceof MicrophoneUnavailableError && error.insecure) {
    return insecureOriginMessage("open a microphone");
  }
  if (error instanceof CaptureUnavailableError && error.insecure) {
    return insecureOriginMessage(error.kind === "camera" ? "open a camera" : "capture a screen");
  }
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

/** What an insecure origin costs, and the two things that really mend it.
 *
 *  Both are named because this app is reached three ways and they do not overlap: an https
 *  front, loopback on the machine itself, and a private address on a VPN or an overlay
 *  network, where no certificate is possible and the browser's own per-origin allowance is
 *  the only thing that works. The flag's exact name is one paragraph away in Settings, where
 *  `pushBlockerRemedy` already spells it — this is a notice that leaves on its own.
 *
 *  WebKit publishes no such allowance, so the flag is named as a DESKTOP fix and https as the
 *  iPhone's only one. Sending an iPhone reader hunting a switch that does not exist is the
 *  same defect as blaming their permissions, one platform over — and `pushBlockerRemedy` says
 *  it in as many words for the other capability the same missing context takes away. It is
 *  told rather than detected: one true sentence beats a second platform sniff. */
function insecureOriginMessage(what: string): string {
  return (
    `This page is on plain http://, where no browser lets it ${what}. ` +
    "Reach teams-lite over https — on an iPhone that is the only way; a desktop browser can " +
    "allow this one address in its flags instead."
  );
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

/**
 * What to say when the meeting would not ACCEPT a capture at all.
 *
 * The mirror of {@link captureDroppedMessage}, and the reason the two are apart: a section
 * that was accepted and then taken away is worth turning on again, and a section the meeting
 * rejected in the very answer to the offer that added it is not. A real user was given the
 * drop's advice for a refusal, shared their screen a second time, and met the same refusal in
 * the same second — so this one names what actually remains, which is the client that can do
 * it. Sending is not yet verified against a real tenant (NATIVE-CALLING.md § 10.8).
 */
export function captureRefusedMessage(kind: SendKind): string {
  return kind === "camera"
    ? "The meeting would not accept your camera, so nothing was shown. Open this meeting in Teams to use it."
    : "The meeting would not accept your screen share, so nothing was shown. Open this meeting in Teams to share.";
}

/**
 * What to say when the meeting ANSWERED an offer of ours in a way this browser cannot read.
 *
 * It is the third way a capture ends without a click, after a refusal and a drop, and it is
 * the one that used to cost the whole call: the answer to a screen share was thrown out by
 * the browser and this app hung up, so the user lost the person they were talking to a few
 * seconds after sharing. So the sentence's second half is the load-bearing one — it says the
 * call is still there, because everything the user can see says otherwise.
 */
export function renegotiationRefusedMessage(released: SendKind[]): string {
  const what = releasedNames(released);
  return what
    ? `The meeting's answer could not be read here, so ${what} stopped. You are still in the call.`
    : "The meeting's answer could not be read here. You are still in the call, and nothing else changed.";
}

/** The captures that went off, named the way the user would name them. */
function releasedNames(released: SendKind[]): string {
  const names = released.map((kind) =>
    kind === "camera" ? "your camera" : "your screen share",
  );
  // Both at once is a real state — a camera and a screen travel on one offer — and "your
  // camera, your screen share" reads as a list of things rather than as two that stopped.
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
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
