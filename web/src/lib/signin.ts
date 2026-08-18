// Signing in again from the app: every decision the panel makes, with no DOM in it.
//
// The surface is unusual for this app — a picture of somebody else's window, with a keyboard
// and a pointer pointed at it — so the parts that can be got wrong invisibly live here and
// are unit-tested: which of the two remedies the banner offers, what each phase says, where a
// tap on a scaled picture really lands, and which keystrokes are worth sending at all.
//
// The backend half is src/signin.rs; SIGN-IN.md is the measured map of the window itself.

import type { BrokerStatus, SigninPhase, SigninState } from "./protocol";

/** How often the page asks for a new frame while the reader is working in the window.
 *
 *  A second, and it is a deliberate floor rather than a target: the frame is a whole PNG of
 *  the window (measured at 34 KB for the real 550x675 page), the reader is filling in a form
 *  rather than watching a video, and this app is read over a tailnet from a phone. Faster
 *  would spend their data to animate a caret. */
export const FRAME_INTERVAL_MS = 1000;

/** How often the page asks how the sign-in is GOING while no window is up.
 *
 *  Quicker than a frame, because this is the phase that usually ends in under a second — the
 *  broker minting from the machine's own token with nobody in front of it — and the reader is
 *  looking at a spinner until it does. */
export const STATUS_INTERVAL_MS = 400;

/** Which remedy the broken-sign-in banner should offer.
 *
 *  Exactly one, ever, and that is the whole point of deciding it in one place: a banner
 *  offering both "restart the container" and "sign in here" asks the reader to know which
 *  failure they have, which is the thing they came to the app to be told. The backend already
 *  answers both questions per failure (`can_repair`, `can_sign_in`), so this only picks. */
export type BrokerRemedy =
  | { kind: "repair" }
  | { kind: "signin" }
  | { kind: "blocked"; message: string }
  | { kind: "none" };

export function brokerRemedy(broker: BrokerStatus | null | undefined): BrokerRemedy {
  if (!broker || broker.ok) return { kind: "none" };
  // The repair comes first where it applies: it is the failure whose cause is a keyring that
  // re-locked, it needs nobody, and a sign-in window could not even be drawn for it.
  if (broker.can_repair) return { kind: "repair" };
  if (broker.can_sign_in) return { kind: "signin" };
  // A failure that WOULD call for a sign-in, on a machine where one cannot be served: the
  // broker's display is gone, or there is none. Say which, rather than showing a dead button
  // with no words — the mistake this banner's `refused` branch already had once.
  if (broker.signin_blocker) return { kind: "blocked", message: broker.signin_blocker };
  return { kind: "none" };
}

/** What the panel says and offers, per phase.
 *
 *  `busy` drives the spinner, `window` says whether a frame is worth asking for, and `done`
 *  is what lets the panel take itself away. Nothing here reads a clock: a phase is what the
 *  backend says it is. */
export type SigninView = {
  title: string;
  detail: string;
  /** Is anything still happening? */
  busy: boolean;
  /** Should the page be polling for frames — i.e. is there a window to draw? */
  showsWindow: boolean;
  /** Can the reader still cancel? */
  canCancel: boolean;
  /** Has it finished, whichever way? */
  settled: boolean;
};

export function signinView(state: SigninState): SigninView {
  switch (state.phase) {
    case "starting":
      return {
        title: "Signing in…",
        // The honest description of what is happening, and it is the common case: most of
        // the time this ends here, because the machine's own token is enough and no page is
        // ever shown. Promising a password prompt would make the good outcome look like a
        // failure to appear.
        detail: "Asking Microsoft. If this machine can do it on its own, nothing else is needed.",
        busy: true,
        showsWindow: false,
        canCancel: true,
        settled: false,
      };
    case "waiting":
      return {
        title: "Microsoft is asking you to sign in",
        detail:
          "This is Microsoft's own sign-in page, running on the machine. Type your password " +
          "into it. If it shows a number, enter that number in your Authenticator app.",
        busy: false,
        showsWindow: true,
        canCancel: true,
        settled: false,
      };
    case "done":
      return {
        title: "Sign-in works again",
        detail: "The app is catching up on its own — nothing else to do.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "cancelled":
      return {
        title: "Sign-in was closed",
        detail: "Nothing changed. You can start it again whenever you like.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "failed":
      return {
        title: "Sign-in did not finish",
        // The backend's own sentence, which names the cause. Never replaced by a generic
        // one: this is the surface a reader takes to whoever runs the tenant.
        detail: state.detail || "The machine could not complete the sign-in.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "idle":
    default:
      return {
        title: "",
        detail: "",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: false,
      };
  }
}

/** Where a tap on the drawn frame lands in the broker's own window.
 *
 *  The frame is drawn at whatever width the layout gives it — a phone is narrower than the
 *  550 px window, a laptop may be wider — so a click's page coordinates are in the SCALED
 *  picture and the window wants its own. Getting this wrong is the failure that looks like
 *  the page ignoring taps: the reader hits "Sign in" and a point 40 px above it is pressed.
 *
 *  Returns null when the frame has no size yet (a picture that has not loaded), rather than
 *  dividing by zero and sending the pointer to a corner. */
export function pointInWindow(
  click: { x: number; y: number },
  drawn: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } | null {
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  const x = ((click.x - drawn.left) / drawn.width) * size.width;
  const y = ((click.y - drawn.top) / drawn.height) * size.height;
  // Clamped to the window: a tap on the mat around the picture is still a tap the reader
  // meant to make somewhere in it, and the backend clamps again against the real geometry.
  return {
    x: Math.round(Math.min(Math.max(x, 0), size.width - 1)),
    y: Math.round(Math.min(Math.max(y, 0), size.height - 1)),
  };
}

/** What a keystroke becomes on the wire, or null for one not worth sending. */
export type SigninKey = { char: string } | { key: string };

/** The named keys this app forwards. The same list the backend accepts (`Key::keysym` in
 *  src/xwindow.rs), which is what keeps a key from being drawn as sent and then dropped. */
/// ESCAPE IS DELIBERATELY ABSENT. Forwarded, one press did two things: it typed Escape into
/// Microsoft's page AND dismissed the panel — `preventDefault` does not stop the event reaching
/// Radix's own document listener — so a reader closing a dropdown inside the sign-in page lost
/// the whole panel while the broker still held their flow.
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
]);

/** Turn a DOM keydown into a keystroke for the window, or null to leave it alone.
 *
 *  Two rules, and both keep this from becoming a keylogger with extra steps:
 *
 *  * a MODIFIED key is never forwarded (Ctrl/Meta/Alt) — those are the browser's own
 *    shortcuts, and a reader pressing ⌘R means to reload the app rather than to send a
 *    keystroke into somebody else's window; and
 *  * anything that is not one printable character or a name on the list above is dropped,
 *    so `F5`, `CapsLock` and `Shift` itself send nothing. */
export function keyFromKeydown(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): SigninKey | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (NAMED_KEYS.has(event.key)) return { key: event.key };
  // `event.key` is the character for a printable key, and a word ("Shift", "F5") otherwise.
  // One code point, counted as characters rather than as UTF-16 units so an emoji is one.
  const [only, ...rest] = [...event.key];
  if (only !== undefined && rest.length === 0) return { char: only };
  return null;
}

/** Turn text a phone's keyboard inserted into keystrokes, one per character.
 *
 *  A mobile keyboard reports its own insertions rather than key presses — Android sends
 *  keyCode 229 for every letter — so the panel reads the inserted TEXT and this splits it.
 *  One character per message, deliberately: the backend refuses a "character" of ten letters
 *  (`parse_key` in src/signin.rs), because a whole password arriving in one field is exactly
 *  what this design is trying not to build. */
export function keysFromInsertedText(text: string): SigninKey[] {
  return [...text].map((char) => ({ char }));
}

/** Is this phase one the panel should be on screen for at all? */
export function signinIsOpen(phase: SigninPhase): boolean {
  return phase !== "idle";
}
