import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLabel,
  pushBlocker,
  pushBlockerMessage,
  readPushEnvironment,
} from "./push";

/** A browser that supports everything push needs. */
function capableWindow(overrides: Record<string, unknown> = {}) {
  return {
    PushManager: function PushManager() {},
    Notification: Object.assign(function Notification() {}, { permission: "default" }),
    matchMedia: () => ({ matches: false }),
    ...overrides,
  } as never;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("readPushEnvironment", () => {
  it("reports a capable, installed browser", () => {
    const env = readPushEnvironment(
      { serviceWorker: {} as ServiceWorkerContainer, userAgent: IPHONE_UA, standalone: true },
      capableWindow(),
    );
    expect(env).toEqual({
      capable: true,
      installed: true,
      appleMobile: true,
      permission: "default",
    });
  });

  it("reports an iPhone Safari TAB as not capable and not installed", () => {
    // The real shape on iOS outside a Home Screen app: no PushManager, no
    // Notification. That is why "needs-install" has to be a distinct answer.
    const env = readPushEnvironment(
      { serviceWorker: {} as ServiceWorkerContainer, userAgent: IPHONE_UA },
      { matchMedia: () => ({ matches: false }) } as never,
    );
    expect(env.capable).toBe(false);
    expect(env.installed).toBe(false);
    expect(env.appleMobile).toBe(true);
    expect(env.permission).toBe("unavailable");
  });

  it("treats an iPad that claims to be a Mac as an Apple mobile device", () => {
    const env = readPushEnvironment(
      { serviceWorker: {} as ServiceWorkerContainer, userAgent: MAC_UA, maxTouchPoints: 5 },
      capableWindow(),
    );
    expect(env.appleMobile).toBe(true);
  });

  it("does not mistake a desktop Mac for a mobile one", () => {
    const env = readPushEnvironment(
      { serviceWorker: {} as ServiceWorkerContainer, userAgent: MAC_UA, maxTouchPoints: 0 },
      capableWindow(),
    );
    expect(env.appleMobile).toBe(false);
  });

  it("counts a standalone display-mode as installed", () => {
    const env = readPushEnvironment(
      { serviceWorker: {} as ServiceWorkerContainer, userAgent: MAC_UA },
      capableWindow({ matchMedia: (q: string) => ({ matches: q.includes("standalone") }) }),
    );
    expect(env.installed).toBe(true);
  });

  it("survives a server render, where there is no browser at all", () => {
    const env = readPushEnvironment({}, {});
    expect(env.capable).toBe(false);
    expect(env.permission).toBe("unavailable");
  });
});

describe("pushBlocker", () => {
  const capable = { capable: true, installed: true, appleMobile: false, permission: "default" as const };

  it("clears the way when the browser and the backend both agree", () => {
    expect(pushBlocker(capable, true)).toBe(null);
  });

  it("puts the backend first: nothing else matters when it never pushes", () => {
    expect(pushBlocker(capable, false)).toBe("backend");
    expect(pushBlocker({ ...capable, capable: false }, false)).toBe("backend");
  });

  it("asks an iPhone to install the app rather than calling it unsupported", () => {
    const tab = { capable: false, installed: false, appleMobile: true, permission: "unavailable" as const };
    expect(pushBlocker(tab, true)).toBe("needs-install");
    expect(pushBlockerMessage("needs-install")).toContain("Add to Home Screen");
  });

  it("calls a browser without the APIs unsupported", () => {
    const old = { capable: false, installed: false, appleMobile: false, permission: "unavailable" as const };
    expect(pushBlocker(old, true)).toBe("unsupported");
  });

  it("reports a refused permission, which only the OS can undo", () => {
    expect(pushBlocker({ ...capable, permission: "denied" }, true)).toBe("denied");
  });

  it("uses the backend's own reason when it has one", () => {
    expect(pushBlockerMessage("backend", "read-only")).toBe("read-only");
    expect(pushBlockerMessage(null)).toBe(null);
  });
});

describe("base64url keys", () => {
  it("round-trips a key through both directions", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes.buffer);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it("decodes an unpadded VAPID key of the length the browser demands", () => {
    // The 65-byte uncompressed P-256 point from RFC 8291's example. `subscribe`
    // rejects anything else, so the length is the assertion that matters.
    const key =
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    expect(base64UrlToBytes(key).length).toBe(65);
  });
});

describe("deviceLabel", () => {
  it("names the device and the browser", () => {
    expect(deviceLabel({ userAgent: IPHONE_UA })).toBe("iPhone · Safari");
    expect(deviceLabel({ userAgent: MAC_UA })).toBe("Mac · Chrome");
  });

  it("does not let a Chromium claim Safari, nor Edge claim Chrome", () => {
    const edge = `${MAC_UA} Edg/140.0.0.0`;
    expect(deviceLabel({ userAgent: edge })).toBe("Mac · Edge");
  });

  it("falls back rather than inventing a name", () => {
    expect(deviceLabel({})).toBe("Device · Browser");
  });
});
