// Two recovery behaviours the always-on service depends on, pinned mechanically.
//
// `src/lib/store.ts` is the integration layer: it owns a Backend, the DOM and
// `fetch`, so no test constructs it. What CAN be checked, and what matters here, is
// that two lines stay where they are — the same way `src/mail.rs` proves its
// read-only lock by scanning its own source rather than by making a request.
//
// It lives in scripts/ rather than next to store.ts because it reads that file from
// disk: the browser tsconfig deliberately has no node types, while scripts/ is
// type-checked against `types: ["bun"]` (tsconfig.node.json).
//
// Both behaviours exist because the app is now served by a permanent background
// service that the user reaches from a phone (see AGENTS.md § The always-on service).
// That makes two events routine which used to be rare: the backend restarts under a
// page that stays open for days, and iOS restores that page from the back/forward
// cache.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(join(WEB_DIR, "src", "lib", "store.ts"), "utf8");

/** The body of `on("<event>", …)`, up to the closing `});` of that handler. */
function handlerBody(event: string): string {
  const start = STORE.indexOf(`on("${event}"`);
  expect(start, `no on("${event}") handler in store.ts`).toBeGreaterThan(-1);
  const end = STORE.indexOf("\n    });", start);
  expect(end, `could not find the end of the ${event} handler`).toBeGreaterThan(start);
  return STORE.slice(start, end);
}

describe("recovery after a backend restart", () => {
  it("refetches the write token when the socket comes back", () => {
    // The backend mints a write token per PROCESS, so a restart invalidates the one
    // this page holds. Reads keep working, which is what makes it nasty: the tab
    // looks healthy and every send is refused, silently, until a reload. On a phone
    // tab left open for days, a restart is routine.
    expect(
      handlerBody("reconnected"),
      'the "reconnected" handler must call loadWriteToken(), or a backend restart ' +
        "leaves an open phone tab unable to send until the page is reloaded",
    ).toContain("loadWriteToken()");
  });

  it("treats a bfcache restore as a wake-up", () => {
    // iOS Safari restores a page from the back/forward cache with `pageshow`
    // (`persisted: true`) and does not always fire `visibilitychange`, so the socket
    // would stay closed after a back gesture.
    const wakeups = STORE.slice(
      STORE.indexOf("private watchWakeups()"),
      STORE.indexOf("private wireEvents()"),
    );
    expect(wakeups).toContain('addEventListener("pageshow"');
    expect(wakeups).toContain("event.persisted");
    // And it must be removed again: the store is disposable, and a listener that
    // outlives it keeps a dead Backend reachable.
    expect(wakeups).toContain('removeEventListener("pageshow"');
  });
});
