import { describe, expect, it } from "vitest";
import {
  brokerRemedy,
  keyFromKeydown,
  keysFromInsertedText,
  pointInWindow,
  signinIsOpen,
  signinView,
} from "./signin";
import { INITIAL_SIGNIN, type BrokerStatus, type SigninState } from "./protocol";

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

  it("offers the sign-in for the failure a restart cannot fix", () => {
    expect(brokerRemedy(broken({ can_sign_in: true })).kind).toBe("signin");
  });

  it("says WHY when a sign-in is what is needed and cannot be served", () => {
    const remedy = brokerRemedy(
      broken({ can_sign_in: false, signin_blocker: "no display for the window" }),
    );
    expect(remedy).toEqual({ kind: "blocked", message: "no display for the window" });
  });

  it("reads a backend too old to answer as offering nothing", () => {
    // `can_sign_in` absent must never be hopeful: the panel would open on nothing.
    const old = broken();
    expect(old.can_sign_in).toBeUndefined();
    expect(brokerRemedy(old).kind).toBe("none");
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
