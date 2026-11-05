import { describe, expect, it } from "vitest";
import {
  brokerRemedy,
  enrollmentIsLive,
  keyFromKeydown,
  keysFromInsertedText,
  pointInWindow,
  signinIsOpen,
  signinView,
} from "./signin";
import {
  INITIAL_SIGNIN,
  type BrokerStatus,
  type EmbeddedIntune,
  type SigninState,
} from "./protocol";

const broken = (over: Partial<BrokerStatus> = {}): BrokerStatus => ({
  ok: false,
  signature: "refused",
  message: "The identity broker refused to sign in silently.",
  detail: "",
  consecutive_failures: 3,
  can_repair: false,
  repairing: false,
  ...over,
});

const at = (over: Partial<SigninState>): SigninState => ({ ...INITIAL_SIGNIN, ...over });

/** An embedded backend's own container, up and enrolled, with nothing at work. */
const embedded = (over: Partial<EmbeddedIntune> = {}): EmbeddedIntune => ({
  mode: "embedded",
  helper: null,
  initialized: true,
  registered: true,
  running: true,
  can_enroll: false,
  ...over,
});

describe("brokerRemedy", () => {
  it("says nothing while sign-in works, and nothing without a status", () => {
    expect(brokerRemedy(null).kind).toBe("none");
    expect(brokerRemedy(undefined).kind).toBe("none");
    expect(brokerRemedy(broken({ ok: true })).kind).toBe("none");
  });

  it("offers exactly one remedy, and the container restart wins where it applies", () => {
    // A locked keyring is repaired by the restart and needs nobody. Offering a sign-in beside
    // it would ask the reader to know which failure they have.
    const both = broken({ signature: "keyring_locked", can_repair: true, can_sign_in: true });
    expect(brokerRemedy(both).kind).toBe("repair");
  });

  it("keeps a running repair on screen whatever the failure turns into meanwhile", () => {
    // The repair stops the container and the backend stays up through it, so the failure it
    // records halfway through is the one a stopped container looks like — no broker on the bus
    // at all — which is not one a restart fixes. The repair the reader asked for is still
    // running, and that is what the banner has to say, not "sign in to Intune again".
    const midway = broken({ signature: "unreachable", can_repair: false, repairing: true });
    expect(brokerRemedy(midway).kind).toBe("repair");
    // Nor is a sign-in offered over it: the broker that would draw the window is the one
    // being restarted.
    expect(brokerRemedy({ ...midway, can_sign_in: true }).kind).toBe("repair");
    // And once the backend says the repair ended, the failure decides again.
    expect(brokerRemedy({ ...midway, repairing: false }).kind).toBe("none");
  });

  it("offers the sign-in for the failure a restart cannot fix", () => {
    expect(brokerRemedy(broken({ can_sign_in: true })).kind).toBe("signin");
  });

  it("says WHY when a sign-in is what is needed and cannot be served", () => {
    const remedy = brokerRemedy(
      broken({ can_sign_in: false, signin_blocker: "no display for the window" }),
    );
    expect(remedy).toEqual({ kind: "blocked", message: "no display for the window" });
  });

  it("says WHO can restart the container when this backend may not", () => {
    // teams-lite's container image: a restart is the cure for a locked keyring, and only the
    // host can make it. The fallback "a restart won't fix this one" would be false there.
    const image = broken({
      signature: "keyring_locked",
      can_repair: false,
      repair_blocker: "run it on the host",
    });
    expect(brokerRemedy(image)).toEqual({ kind: "repair_blocked", message: "run it on the host" });
    // A repair running on the machine still wins: the host's own install started it.
    expect(brokerRemedy({ ...image, repairing: true }).kind).toBe("repair");
    // And a backend that may repair never shows the blocker, whatever else it carries.
    expect(brokerRemedy({ ...image, can_repair: true }).kind).toBe("repair");
  });

  it("draws exactly what it always drew for a host-mode status", () => {
    // `intune: null` is a host-mode backend, and absent is one too old to know about embedded
    // mode. Every remedy above must come out the same for both.
    for (const intune of [null, undefined]) {
      expect(brokerRemedy(broken({ can_sign_in: true, intune })).kind).toBe("signin");
      expect(brokerRemedy(broken({ signature: "keyring_locked", can_repair: true, intune })).kind).toBe(
        "repair",
      );
      expect(brokerRemedy(broken({ signature: "no_account", intune })).kind).toBe("none");
    }
  });

  it("reads a backend too old to answer as offering nothing", () => {
    // `can_sign_in` absent must never be hopeful: the panel would open on nothing.
    const old = broken();
    expect(old.can_sign_in).toBeUndefined();
    expect(brokerRemedy(old).kind).toBe("none");
  });
});

describe("brokerRemedy in embedded mode", () => {
  it("says the container is being started, and whether it is the 1.7 GB first start", () => {
    const first = brokerRemedy(
      broken({ signature: "unreachable", intune: embedded({ helper: "boot", initialized: false }) }),
    );
    expect(first).toEqual({ kind: "starting", firstStart: true });
    const again = brokerRemedy(
      broken({ signature: "unreachable", intune: embedded({ helper: "boot", running: false }) }),
    );
    expect(again).toEqual({ kind: "starting", firstStart: false });
    // A boot wins over the failures it is the cause of — a restart or a sign-in cannot help a
    // broker that is not up yet.
    expect(
      brokerRemedy(
        broken({ can_repair: true, can_sign_in: true, intune: embedded({ helper: "boot" }) }),
      ).kind,
    ).toBe("starting");
  });

  it("offers the enrollment for an up container with no registration, over every other remedy", () => {
    const fresh = embedded({ registered: false, can_enroll: true });
    expect(brokerRemedy(broken({ signature: "no_account", intune: fresh })).kind).toBe("enroll");
    // A registration is a fact read off the container; a sign-in or a repair rests on a
    // signature, and neither can sign anybody in on a device that is not enrolled.
    expect(brokerRemedy(broken({ can_sign_in: true, intune: fresh })).kind).toBe("enroll");
    expect(brokerRemedy(broken({ can_repair: true, intune: fresh })).kind).toBe("enroll");
    // But a repair the reader asked for keeps the banner while it runs.
    expect(brokerRemedy(broken({ repairing: true, intune: fresh })).kind).toBe("repair");
    // And it is the backend's answer, never derived: an unregistered container it does not
    // offer one for (a read-only backend) offers no press — and says so in the embedded words,
    // never the host-mode ones.
    expect(
      brokerRemedy(broken({ signature: "no_account", intune: embedded({ registered: false }) })),
    ).toEqual({ kind: "embedded_other", registered: false });
  });

  it("stops offering the press the moment this page makes it", () => {
    // The portal helper takes the slot a moment after the press, and the backend's
    // `can_enroll` is still true in between: the page's own session is what says so first.
    const fresh = broken({ signature: "no_account", intune: embedded({ registered: false, can_enroll: true }) });
    const opening = at({ kind: "enroll", phase: "starting" });
    expect(brokerRemedy(fresh, opening)).toEqual({
      kind: "enrolling",
      session: "live",
      purpose: "enroll",
    });
    expect(brokerRemedy(fresh, at({ kind: "enroll", phase: "waiting" }))).toEqual({
      kind: "enrolling",
      session: "live",
      purpose: "enroll",
    });
    // A settled enrollment is no longer under way, and a SIGN-IN is not an enrollment.
    expect(brokerRemedy(fresh, at({ kind: "enroll", phase: "cancelled" })).kind).toBe("enroll");
    expect(brokerRemedy(fresh, at({ phase: "starting" })).kind).toBe("enroll");
    // A portal still open with no session behind it here is said as what it is.
    const leftOpen = broken({ intune: embedded({ registered: false, helper: "portal" }) });
    expect(brokerRemedy(leftOpen, INITIAL_SIGNIN)).toEqual({
      kind: "enrolling",
      session: "elsewhere",
      purpose: "enroll",
    });
  });

  it("says a portal this page has closed is CLOSING, never still open, until its helper has gone", () => {
    // The helper closes the portal, which takes seconds, and the slot is free only once it has
    // exited — so the backend can still name it after the panel has settled. Saying "still open"
    // then would contradict the panel the reader just watched close.
    const held = broken({ intune: embedded({ registered: false, helper: "portal" }) });
    for (const phase of ["cancelled", "failed", "done"] as const) {
      expect(brokerRemedy(held, at({ kind: "enroll", phase }))).toEqual({
        kind: "enrolling",
        session: "closing",
        purpose: "enroll",
      });
    }
    // A Cancel being carried out is closing too, before the session has even settled.
    expect(brokerRemedy(held, at({ kind: "enroll", phase: "waiting", stopping: true }))).toEqual({
      kind: "enrolling",
      session: "closing",
      purpose: "enroll",
    });
    // And once the helper has gone, the offer comes back.
    const free = broken({ intune: embedded({ registered: false, can_enroll: true }) });
    expect(brokerRemedy(free, at({ kind: "enroll", phase: "cancelled" })).kind).toBe("enroll");
  });

  it("offers the portal to sign an account in on an enrolled container whose broker holds none", () => {
    // It used to fall through to the host-mode remedy: a dead button and "sign in to Intune
    // again", with a tool this image does not have.
    const missing = broken({
      signature: "no_account",
      intune: embedded({ registered: true, can_portal_sign_in: true }),
    });
    expect(brokerRemedy(missing)).toEqual({ kind: "portal_signin" });
    // It is the backend's answer, never derived: absent — an older backend — offers no press,
    // and still never the host-mode words.
    expect(brokerRemedy(broken({ signature: "no_account", intune: embedded() }))).toEqual({
      kind: "embedded_other",
      registered: true,
    });
    // Enrolling wins where both could be said, and a running repair or boot keeps the banner.
    const both = embedded({ registered: false, can_enroll: true, can_portal_sign_in: true });
    expect(brokerRemedy(broken({ intune: both })).kind).toBe("enroll");
    expect(
      brokerRemedy(broken({ repairing: true, intune: embedded({ can_portal_sign_in: true }) })).kind,
    ).toBe("repair");
    // While the portal is open for it, the banner follows that session, in its words.
    const signingIn = at({ kind: "enroll", purpose: "account", phase: "waiting", registered: true });
    expect(brokerRemedy(missing, signingIn)).toEqual({
      kind: "enrolling",
      session: "live",
      purpose: "account",
    });
  });

  it("never falls through to the host-mode sentence in embedded mode", () => {
    // "Sign in to Intune again" names `intune-container` on the machine, which this image has
    // not got. Every embedded failure the remedies above do not cover says something true.
    for (const signature of ["no_account", "other", "unresponsive", "refused"]) {
      expect(brokerRemedy(broken({ signature, intune: embedded() })).kind).not.toBe("none");
    }
    expect(brokerRemedy(broken({ signature: "other", intune: embedded() }))).toEqual({
      kind: "embedded_other",
      registered: true,
    });
    // A host-mode status keeps its fallback exactly.
    expect(brokerRemedy(broken({ signature: "no_account", intune: null })).kind).toBe("none");
  });

  it("says the container is down rather than sending the reader to sign in to Intune", () => {
    // The host-mode fallback ("sign in to Intune again") is false when the container is the
    // app's own and the app starts it.
    const down = broken({ signature: "unreachable", intune: embedded({ running: false }) });
    expect(brokerRemedy(down)).toEqual({ kind: "stopped", firstStart: false });
    const neverSetUp = broken({
      signature: "unreachable",
      intune: embedded({ running: false, initialized: false, registered: false }),
    });
    expect(brokerRemedy(neverSetUp)).toEqual({ kind: "stopped", firstStart: true });
    // A repair that would cure it is still offered where it applies.
    expect(
      brokerRemedy(broken({ can_repair: true, intune: embedded({ running: false }) })).kind,
    ).toBe("repair");
    // An up, enrolled container falls through to the remedies it always had.
    expect(brokerRemedy(broken({ can_sign_in: true, intune: embedded() })).kind).toBe("signin");
  });

  it("says nothing while sign-in works, whatever the container is doing", () => {
    expect(brokerRemedy(broken({ ok: true, intune: embedded({ helper: "boot" }) })).kind).toBe("none");
  });
});

describe("enrollmentIsLive", () => {
  it("is an enrollment that has not settled, and nothing else", () => {
    expect(enrollmentIsLive(at({ kind: "enroll", phase: "starting" }))).toBe(true);
    expect(enrollmentIsLive(at({ kind: "enroll", phase: "waiting" }))).toBe(true);
    expect(enrollmentIsLive(at({ kind: "enroll", phase: "done" }))).toBe(false);
    expect(enrollmentIsLive(at({ phase: "waiting" }))).toBe(false);
    // An absent kind is a backend too old to enroll anything: a sign-in.
    expect(enrollmentIsLive(at({ kind: undefined, phase: "waiting" }))).toBe(false);
    expect(enrollmentIsLive(null)).toBe(false);
  });
});

describe("signinView", () => {
  it("draws nothing at all when idle", () => {
    const view = signinView(INITIAL_SIGNIN);
    expect(view.title).toBe("");
    expect(view.showsWindow).toBe(false);
    expect(signinIsOpen("idle")).toBe(false);
  });

  it("describes the common case honestly while starting", () => {
    const view = signinView(at({ phase: "starting" }));
    expect(view.busy).toBe(true);
    // No window yet, so no frame is worth asking for.
    expect(view.showsWindow).toBe(false);
    expect(view.canCancel).toBe(true);
    expect(view.settled).toBe(false);
    // It must not promise a password prompt: most sign-ins end here with nobody typing.
    expect(view.detail).toContain("on its own");
  });

  it("says whose page it is, and names the number, once a window is up", () => {
    const view = signinView(at({ phase: "waiting", window: { width: 550, height: 675 } }));
    expect(view.showsWindow).toBe(true);
    expect(view.busy).toBe(false);
    expect(view.detail).toContain("Microsoft's own sign-in page");
    // The one instruction a reader cannot work out for themselves.
    expect(view.detail).toContain("Authenticator");
  });

  it("settles three ways, and only a failure carries the backend's own words", () => {
    expect(signinView(at({ phase: "done" })).settled).toBe(true);
    expect(signinView(at({ phase: "cancelled" })).settled).toBe(true);
    const failed = signinView(at({ phase: "failed", detail: "the bus timed out" }));
    expect(failed.settled).toBe(true);
    expect(failed.detail).toBe("the bus timed out");
    // A failure with nothing said still says something.
    expect(signinView(at({ phase: "failed" })).detail.length).toBeGreaterThan(0);
    // Nothing settled offers a cancel, and none of them keeps polling for frames.
    for (const phase of ["done", "cancelled", "failed"] as const) {
      expect(signinView(at({ phase })).canCancel).toBe(false);
      expect(signinView(at({ phase })).showsWindow).toBe(false);
    }
  });
});

describe("signinView for an enrollment", () => {
  it("says whose window it is, and never promises the machine can do it alone", () => {
    const opening = signinView(at({ kind: "enroll", phase: "starting" }));
    expect(opening.title).toContain("Intune portal");
    expect(opening.busy).toBe(true);
    expect(opening.detail).not.toContain("on its own");
    expect(opening.waitingLabel).toContain("Intune portal");
    const open = signinView(at({ kind: "enroll", phase: "waiting" }));
    expect(open.showsWindow).toBe(true);
    expect(open.title).toBe("Enroll this device");
    expect(open.detail).toContain("Intune portal");
    expect(open.detail).toContain("Authenticator");
    expect(open.frameAlt).toContain("Intune portal");
    expect(open.cancelLabel).toBe("Cancel");
  });

  it("hands the close to the reader once the container holds a registration", () => {
    // The portal goes on after the registration lands (a compliance check, the policies), so
    // the panel says it is registered and the reader closes the portal when it is finished.
    const registered = signinView(at({ kind: "enroll", phase: "waiting", registered: true }));
    expect(registered.title).toContain("registered");
    expect(registered.cancelLabel).toBe("Close the portal");
    expect(registered.canCancel).toBe(true);
    expect(registered.showsWindow).toBe(true);
  });

  it("settles in the enrollment's own words", () => {
    expect(signinView(at({ kind: "enroll", phase: "done" })).title).toContain("enrolled");
    expect(signinView(at({ kind: "enroll", phase: "cancelled" })).detail).toContain(
      "nothing was registered",
    );
    expect(signinView(at({ kind: "enroll", phase: "failed", detail: "exit 1" })).detail).toBe("exit 1");
    for (const phase of ["done", "cancelled", "failed"] as const) {
      expect(signinView(at({ kind: "enroll", phase })).settled).toBe(true);
      expect(signinView(at({ kind: "enroll", phase })).canCancel).toBe(false);
    }
  });

  it("says the portal is CLOSING once the reader has cancelled, and offers nothing to press", () => {
    // The backend asks the portal's helper to close the portal and settles only once it has, so
    // for those seconds nothing is served — no window, no keys — and a second Cancel would be a
    // control that changes nothing.
    for (const phase of ["starting", "waiting"] as const) {
      const closing = signinView(at({ kind: "enroll", phase, stopping: true }));
      expect(closing.title).toBe("Closing the Intune portal…");
      expect(closing.busy).toBe(true);
      expect(closing.showsWindow).toBe(false);
      expect(closing.canCancel).toBe(false);
      expect(closing.settled).toBe(false);
    }
    // A sign-in being cancelled says so in its own words.
    const signin = signinView(at({ phase: "waiting", stopping: true }));
    expect(signin.title).toBe("Closing the sign-in…");
    expect(signin.canCancel).toBe(false);
    // A settled session is settled, whatever a late `stopping` says.
    expect(signinView(at({ kind: "enroll", phase: "cancelled", stopping: true })).settled).toBe(true);
  });

  it("leaves a sign-in's words exactly as they were", () => {
    const view = signinView(at({ phase: "waiting" }));
    expect(view.cancelLabel).toBe("Cancel");
    expect(view.waitingLabel).toBe("Waiting for Microsoft…");
    expect(view.frameAlt).toContain("Microsoft's sign-in page");
  });
});

describe("signinView for an account sign-in through the portal", () => {
  const account = (over: Partial<SigninState>) =>
    at({ kind: "enroll", purpose: "account", registered: true, ...over });

  it("never speaks of an enrollment: the device was enrolled before the portal opened", () => {
    const opening = signinView(account({ phase: "starting" }));
    expect(opening.title).toBe("Opening the Intune portal…");
    expect(opening.detail).toContain("holds no account");
    const open = signinView(account({ phase: "waiting" }));
    expect(open.title).toBe("Sign in through the Intune portal");
    expect(open.title).not.toContain("registered");
    expect(open.detail).toContain("Authenticator");
    expect(open.showsWindow).toBe(true);
    // Closing the portal is how the reader FINISHES — the backend then asks the broker.
    expect(open.cancelLabel).toBe("Close the portal");
    expect(signinView(account({ phase: "starting" })).cancelLabel).toBe("Cancel");
  });

  it("settles in its own words, and a close with no account says sign-in is still broken", () => {
    expect(signinView(account({ phase: "done" })).title).toBe("Sign-in works again");
    const closed = signinView(account({ phase: "cancelled" }));
    expect(closed.detail).toContain("still holds no account");
    expect(closed.detail).not.toContain("nothing was registered");
    expect(signinView(account({ phase: "failed", detail: "exit 1" })).detail).toBe("exit 1");
    for (const phase of ["done", "cancelled", "failed"] as const) {
      expect(signinView(account({ phase })).settled).toBe(true);
    }
  });

  it("reads an absent purpose as an enrollment, the only one an older backend has", () => {
    expect(signinView(at({ kind: "enroll", phase: "waiting" })).title).toBe("Enroll this device");
  });
});

describe("pointInWindow", () => {
  const size = { width: 550, height: 675 };

  it("maps a tap on a scaled picture back to the window's own pixels", () => {
    // A phone: the 550px window drawn 275px wide, so everything is at half scale.
    const drawn = { left: 10, top: 100, width: 275, height: 337.5 };
    // The reader taps the middle of the drawn picture.
    expect(pointInWindow({ x: 10 + 137.5, y: 100 + 168.75 }, drawn, size)).toEqual({
      x: 275,
      y: 338,
    });
    // And the top-left corner of the picture is the window's own origin.
    expect(pointInWindow({ x: 10, y: 100 }, drawn, size)).toEqual({ x: 0, y: 0 });
  });

  it("is the identity at 1:1, which is what a laptop gets", () => {
    const drawn = { left: 0, top: 0, width: 550, height: 675 };
    expect(pointInWindow({ x: 431, y: 291 }, drawn, size)).toEqual({ x: 431, y: 291 });
  });

  it("clamps a tap on the mat rather than pressing outside the window", () => {
    const drawn = { left: 0, top: 0, width: 550, height: 675 };
    expect(pointInWindow({ x: -30, y: -30 }, drawn, size)).toEqual({ x: 0, y: 0 });
    expect(pointInWindow({ x: 9999, y: 9999 }, drawn, size)).toEqual({ x: 549, y: 674 });
  });

  it("answers null rather than dividing by zero before the picture has loaded", () => {
    expect(pointInWindow({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, size)).toBeNull();
    expect(
      pointInWindow({ x: 1, y: 1 }, { left: 0, top: 0, width: 550, height: 675 }, { width: 0, height: 0 }),
    ).toBeNull();
  });
});

describe("keyFromKeydown", () => {
  it("sends one printable character as a character", () => {
    expect(keyFromKeydown({ key: "a" })).toEqual({ char: "a" });
    expect(keyFromKeydown({ key: "A" })).toEqual({ char: "A" });
    expect(keyFromKeydown({ key: "é" })).toEqual({ char: "é" });
    expect(keyFromKeydown({ key: "@" })).toEqual({ char: "@" });
    // A space is a character somebody may genuinely have in a password.
    expect(keyFromKeydown({ key: " " })).toEqual({ char: " " });
  });

  it("sends the named keys a form needs, and nothing else", () => {
    expect(keyFromKeydown({ key: "Enter" })).toEqual({ key: "Enter" });
    expect(keyFromKeydown({ key: "Backspace" })).toEqual({ key: "Backspace" });
    expect(keyFromKeydown({ key: "ArrowLeft" })).toEqual({ key: "ArrowLeft" });
    // Escape belongs to the DIALOG. Forwarded, one press typed it into Microsoft's page AND
    // dismissed the panel, because preventDefault does not stop Radix's document listener.
    expect(keyFromKeydown({ key: "Escape" })).toBeNull();
    // Not keys this app presses into somebody's sign-in page.
    expect(keyFromKeydown({ key: "F5" })).toBeNull();
    expect(keyFromKeydown({ key: "Shift" })).toBeNull();
    expect(keyFromKeydown({ key: "CapsLock" })).toBeNull();
    expect(keyFromKeydown({ key: "Meta" })).toBeNull();
  });

  it("never forwards a modified key, because that is the reader's own shortcut", () => {
    // ⌘R means reload the app, not "send R into the window".
    expect(keyFromKeydown({ key: "r", metaKey: true })).toBeNull();
    expect(keyFromKeydown({ key: "c", ctrlKey: true })).toBeNull();
    expect(keyFromKeydown({ key: "Tab", altKey: true })).toBeNull();
  });
});

describe("keysFromInsertedText", () => {
  it("splits what a phone's keyboard inserted into one keystroke per character", () => {
    expect(keysFromInsertedText("abc")).toEqual([{ char: "a" }, { char: "b" }, { char: "c" }]);
    // Counted by code point, so a character outside the BMP is one keystroke and not two.
    expect(keysFromInsertedText("a😀")).toEqual([{ char: "a" }, { char: "😀" }]);
    expect(keysFromInsertedText("")).toEqual([]);
  });
});
