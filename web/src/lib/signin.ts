// Signing in again from the app: every decision the panel makes, with no DOM in it.
//
// The surface is unusual for this app — a picture of somebody else's window, with a keyboard
// and a pointer pointed at it — so the parts that can be got wrong invisibly live here and
// are unit-tested: which of the two remedies the banner offers, what each phase says, where a
// tap on a scaled picture really lands, and which keystrokes are worth sending at all.
//
// The backend half is src/signin.rs; SIGN-IN.md is the measured map of the window itself.
//
// The SAME panel enrolls a device. A backend in embedded mode runs its own Intune container
// (src/intune_embedded.rs), and one nobody has enrolled holds no device registration — so the
// banner offers "Enroll this device", and the panel then serves the Intune portal's window
// instead of the broker's (`kind: "enroll"`). The same portal also signs an ACCOUNT in again on a
// container that is enrolled but whose broker holds none (`purpose: "account"`): nothing else in
// that image can, and the host-mode sentence the banner used to fall through to — "sign in to
// Intune again" — names a tool it does not have. Everything below that names a phase or a remedy
// answers for all three, and a backend in host mode — whose `intune` is null — draws exactly what
// it always drew.

import type {
  BrokerStatus,
  PortalPurpose,
  SigninKind,
  SigninPhase,
  SigninState,
} from "./protocol";

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
 *  answers both questions per failure (`can_repair`, `can_sign_in`) and says whether a repair
 *  is running (`repairing`), so this only picks.
 *
 *  Six of them exist only in EMBEDDED mode, where the Intune container is the app's own:
 *  `starting` (its boot helper is at work — the first start downloads about 1.7 GB, so it says
 *  which), `enrolling` (the portal is open — or closing — for a session; `session` says whether it
 *  is THIS page's live session, which can be shown again, this page's session that has ended while
 *  its portal is still closing, or nobody's this page knows), `enroll` (the container is up and
 *  holds no device registration: the one remedy only a person can carry out), `portal_signin` (it
 *  is registered and its broker holds no account: the portal signs one in again), `stopped` (the
 *  container is not running and nothing is starting it — the app tries again on its own), and
 *  `embedded_other` (up, and nothing this app can do from here mends the failure). Every one of
 *  them exists so that an embedded backend NEVER falls through to the host-mode sentence "sign in
 *  to Intune again", which names a tool the image does not have. */
export type BrokerRemedy =
  | { kind: "repair" }
  | { kind: "signin" }
  | { kind: "blocked"; message: string }
  | { kind: "repair_blocked"; message: string }
  | { kind: "starting"; firstStart: boolean }
  | { kind: "enrolling"; session: "live" | "closing" | "elsewhere"; purpose: PortalPurpose }
  | { kind: "enroll" }
  | { kind: "portal_signin" }
  | { kind: "stopped"; firstStart: boolean }
  | { kind: "embedded_other"; registered: boolean }
  | { kind: "none" };

/** A session's kind, reading an absent one — a backend too old to enroll anything — as a
 *  sign-in, which is the only kind such a backend has. */
export function sessionKind(session: SigninState | null | undefined): SigninKind {
  return session?.kind === "enroll" ? "enroll" : "signin";
}

/** What a portal session is for, reading an absent purpose — a backend too old to sign an
 *  account in through the portal — as an enrollment, the only purpose such a backend has. */
export function portalPurpose(session: SigninState | null | undefined): PortalPurpose {
  return session?.purpose === "account" ? "account" : "enroll";
}

/** Is this session a portal session (an enrollment, or an account sign-in) that is still going? */
export function enrollmentIsLive(session: SigninState | null | undefined): boolean {
  return (
    sessionKind(session) === "enroll" &&
    (session?.phase === "starting" || session?.phase === "waiting")
  );
}

/** Is this session a portal session that has been ENDED — cancelled and closing, or settled — so
 *  that a portal helper still holding the slot is this page's own one on its way out? */
function enrollmentHasEnded(session: SigninState | null | undefined): boolean {
  if (sessionKind(session) !== "enroll" || !session) return false;
  if (enrollmentIsLive(session)) return Boolean(session.stopping);
  return session.phase !== "idle";
}

export function brokerRemedy(
  broker: BrokerStatus | null | undefined,
  session?: SigninState | null,
): BrokerRemedy {
  if (!broker || broker.ok) return { kind: "none" };
  const intune = broker.intune ?? null;
  // EMBEDDED: the container is being STARTED. Nothing else on this banner can help while it is
  // — a repair would stop the container the boot is bringing up, and a sign-in needs a broker
  // that is not there yet — so the boot wins over every failure it is the cause of.
  if (intune?.helper === "boot") return { kind: "starting", firstStart: !intune.initialized };
  // EMBEDDED: a portal session is under way, or its portal is still on its way out. Read from
  // this page's own session as well as the slot, because the portal helper takes the slot a
  // moment after the press — and in that moment the banner must not go on offering the press the
  // reader has just made — and it lets go of it a moment after the session settles: a portal is
  // closed by its helper, which takes seconds, and the slot is free only once it has exited.
  // Saying the portal is still OPEN then would contradict the panel the reader just watched close.
  const live = enrollmentIsLive(session) && !session?.stopping;
  if (live || intune?.helper === "portal") {
    return {
      kind: "enrolling",
      session: live ? "live" : enrollmentHasEnded(session) ? "closing" : "elsewhere",
      purpose: portalPurpose(session),
    };
  }
  // A repair that is RUNNING wins over everything the failure itself would call for, because
  // the failure is not what it was: the repair stops the container and boots it again, and the
  // backend stays up through that minute and goes on asking for tokens — so it records what a
  // container that is down or still booting looks like (no broker on the bus at all is
  // `unreachable`, a broker not answering yet is `unresponsive`), and neither is one a restart
  // fixes. Read from `can_repair` alone, the banner dropped "Repairing…" halfway through the
  // repair the reader had just asked for and told them to go and sign in to Intune again. The
  // backend says when the repair ends (`repairing: false`), and the failure decides from then.
  // A sign-in is not offered meanwhile either: the broker that would draw its window is the
  // one being restarted.
  if (broker.repairing || intune?.helper === "repair") return { kind: "repair" };
  // EMBEDDED: up, and enrolled nowhere. That is a definite fact read off the container's own
  // state, where every remedy below rests on a failure signature — and nothing below can sign
  // anybody in on a device with no registration. So it comes before them all.
  if (intune?.can_enroll) return { kind: "enroll" };
  // EMBEDDED: enrolled, and its broker holds no account. The portal is how an account is added
  // on an enrolled device, and nothing below can do it: a served sign-in needs an account to name,
  // and a restart fixes a keyring rather than an account. The backend's answer, never derived.
  if (intune?.can_portal_sign_in) return { kind: "portal_signin" };
  // The repair comes first where it applies: it is the failure whose cause is a keyring that
  // re-locked, it needs nobody, and a sign-in window could not even be drawn for it.
  if (broker.can_repair) return { kind: "repair" };
  // A restart IS the cure, and this backend may not make one: teams-lite's container image
  // cannot restart the host's Intune container. Said in the backend's own words, because the
  // fallback below would tell the reader a restart will not help — the one thing that would.
  if (broker.repair_blocker) return { kind: "repair_blocked", message: broker.repair_blocker };
  // EMBEDDED: down, and nothing is starting it — a boot that failed, or a container that went
  // away. Before the sign-in branches, because both of them are about a broker that is not there.
  if (intune && !intune.running) return { kind: "stopped", firstStart: !intune.initialized };
  if (broker.can_sign_in) return { kind: "signin" };
  // A failure that WOULD call for a sign-in, on a machine where one cannot be served: the
  // broker's display is gone, or there is none. Say which, rather than showing a dead button
  // with no words — the mistake this banner's `refused` branch already had once.
  if (broker.signin_blocker) return { kind: "blocked", message: broker.signin_blocker };
  // EMBEDDED, and nothing above applies: never the host-mode fallback, whose remedy is a command
  // this image does not have.
  if (intune) return { kind: "embedded_other", registered: intune.registered };
  return { kind: "none" };
}

/** What the panel says and offers, per phase — and per KIND: a sign-in serves the broker's
 *  window, an enrollment the Intune portal's, and the reader is owed the right words for each.
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
  /** What the control that ends a running flow says. */
  cancelLabel: string;
  /** The line beside the spinner while nothing is drawn yet. */
  waitingLabel: string;
  /** What the frame is, for a screen reader: whose page it is rather than what it looks like. */
  frameAlt: string;
};

const SIGNIN_FRAME_ALT = "Microsoft's sign-in page, running on this machine";
const ENROLL_FRAME_ALT = "The Intune portal, running in this app's own Intune container";

export function signinView(state: SigninState): SigninView {
  if (sessionKind(state) === "enroll") return enrollView(state);
  const common = {
    cancelLabel: "Cancel",
    waitingLabel: "Waiting for Microsoft…",
    frameAlt: SIGNIN_FRAME_ALT,
  };
  if (isStopping(state)) {
    return closingView({ ...common, waitingLabel: "Closing…" }, "Closing the sign-in…", "");
  }
  switch (state.phase) {
    case "starting":
      return {
        ...common,
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
        ...common,
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
        ...common,
        title: "Sign-in works again",
        detail: "The app is catching up on its own — nothing else to do.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "cancelled":
      return {
        ...common,
        title: "Sign-in was closed",
        detail: "Nothing changed. You can start it again whenever you like.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "failed":
      return {
        ...common,
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
        ...common,
        title: "",
        detail: "",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: false,
      };
  }
}

/** Is this a live flow the reader has cancelled, still waiting for what it asked to stop? The
 *  backend serves nothing meanwhile, so the panel must not offer a window, keys or a second
 *  Cancel — the press it just made is being carried out. */
function isStopping(state: SigninState): boolean {
  return Boolean(state.stopping) && (state.phase === "starting" || state.phase === "waiting");
}

/** The view of a flow that is closing: a spinner and the sentence, nothing to press. */
function closingView(
  common: Pick<SigninView, "cancelLabel" | "waitingLabel" | "frameAlt">,
  title: string,
  detail: string,
): SigninView {
  return {
    ...common,
    title,
    detail,
    busy: true,
    showsWindow: false,
    canCancel: false,
    settled: false,
  };
}

/** The portal session's half of {@link signinView}.
 *
 *  Two things differ from a sign-in beyond the words. The portal takes a while to APPEAR the
 *  first time (the crate's own "up to ~30 s"), so `starting` says so rather than implying the
 *  machine might finish on its own — an enrollment never does. And once the container holds a
 *  registration (`registered`) the portal is still open and may still be finishing its steps,
 *  so the panel says the device is registered and the control that ends it becomes "Close the
 *  portal": the backend reads the registration when the portal closes, and settles `done`. */
function enrollView(state: SigninState): SigninView {
  if (portalPurpose(state) === "account") return accountView(state);
  const common = {
    cancelLabel: state.registered ? "Close the portal" : "Cancel",
    waitingLabel: "Opening the Intune portal…",
    frameAlt: ENROLL_FRAME_ALT,
  };
  if (isStopping(state)) {
    return closingView(
      { ...common, waitingLabel: "Closing the Intune portal…" },
      "Closing the Intune portal…",
      "It runs inside this app's own Intune container, and closing it takes a few seconds.",
    );
  }
  switch (state.phase) {
    case "starting":
      return {
        ...common,
        title: "Opening the Intune portal…",
        detail:
          "It runs inside this app's own Intune container, and its window can take half a " +
          "minute to appear the first time.",
        busy: true,
        showsWindow: false,
        canCancel: true,
        settled: false,
      };
    case "waiting":
      return state.registered
        ? {
            ...common,
            title: "This device is registered",
            detail:
              "The Intune container now holds a device registration. Let the portal finish " +
              "anything it is still doing, then close it.",
            busy: false,
            showsWindow: true,
            canCancel: true,
            settled: false,
          }
        : {
            ...common,
            title: "Enroll this device",
            detail:
              "This is Microsoft's Intune portal, running inside this app's own container. Sign " +
              "in with your work account and follow its steps. If it shows a number, enter that " +
              "number in your Authenticator app.",
            busy: false,
            showsWindow: true,
            canCancel: true,
            settled: false,
          };
    case "done":
      return {
        ...common,
        title: "This device is enrolled",
        detail:
          "The Intune container holds a device registration now. Sign-in comes back on its own " +
          "in a moment — nothing else to do.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "cancelled":
      return {
        ...common,
        title: "Enrollment was closed",
        detail:
          "The portal was closed before this device was enrolled, so nothing was registered. " +
          "You can start it again whenever you like.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "failed":
      return {
        ...common,
        title: "Enrollment did not finish",
        // The backend's own sentence, exactly as a sign-in's: it names where to look.
        detail: state.detail || "The Intune portal could not complete the enrollment.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "idle":
    default:
      return {
        ...common,
        title: "",
        detail: "",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: false,
      };
  }
}

/** The ACCOUNT sign-in's half of {@link signinView}: the portal opened on a container that is
 *  enrolled but whose broker holds no account.
 *
 *  The registration says nothing here — it was there before the portal opened — so the words
 *  never mention it, and nothing this page can see says when the account has landed: the backend
 *  asks the broker once the portal closes, and settles `done` when it answers. So the control that
 *  ends it says "Close the portal" once the portal is up, because closing it is how the reader
 *  finishes, and the words say so. */
function accountView(state: SigninState): SigninView {
  const common = {
    cancelLabel: state.phase === "waiting" ? "Close the portal" : "Cancel",
    waitingLabel: "Opening the Intune portal…",
    frameAlt: ENROLL_FRAME_ALT,
  };
  if (isStopping(state)) {
    return closingView(
      { ...common, waitingLabel: "Closing the Intune portal…" },
      "Closing the Intune portal…",
      "Then the app asks the identity broker whether your account is back.",
    );
  }
  switch (state.phase) {
    case "starting":
      return {
        ...common,
        title: "Opening the Intune portal…",
        detail:
          "This device is enrolled, but its identity broker holds no account. The portal runs " +
          "inside this app's own Intune container, and its window can take half a minute to appear.",
        busy: true,
        showsWindow: false,
        canCancel: true,
        settled: false,
      };
    case "waiting":
      return {
        ...common,
        title: "Sign in through the Intune portal",
        detail:
          "This is Microsoft's Intune portal, running inside this app's own container. Sign in " +
          "with your work account. If it shows a number, enter that number in your Authenticator " +
          "app. Close the portal once you are signed in.",
        busy: false,
        showsWindow: true,
        canCancel: true,
        settled: false,
      };
    case "done":
      return {
        ...common,
        title: "Sign-in works again",
        detail: "The identity broker holds your account again — nothing else to do.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "cancelled":
      return {
        ...common,
        title: "The Intune portal was closed",
        detail:
          "The identity broker still holds no account, so sign-in is still broken. You can open " +
          "the portal again whenever you like.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "failed":
      return {
        ...common,
        title: "Sign-in through the portal did not finish",
        detail: state.detail || "The Intune portal could not sign an account in.",
        busy: false,
        showsWindow: false,
        canCancel: false,
        settled: true,
      };
    case "idle":
    default:
      return {
        ...common,
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
