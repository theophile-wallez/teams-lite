// Regression test for the "immortal background CPU spinner" bug.
//
// When the backend is unreachable, the client must NOT reconnect forever: it
// bounds retries and, after `giveUpMs` of continuous failure, emits
// `backend_lost` and stops scheduling timers. That "no timers left" property is
// what lets the process actually exit (via OpenTUI's signal-triggered destroy)
// instead of lingering — reparented to systemd --user, no tty — burning CPU.
//
// We point the client at a closed port and inject tiny tunables so the give-up
// path runs in well under a second.

import { Backend } from "./client";

const DEAD_URL = "ws://127.0.0.1:59999"; // nothing listens here

const b = new Backend(DEAD_URL, { giveUpMs: 250, initialDelayMs: 20, maxDelayMs: 40 });

let lost = false;
let lostAt = 0;
const t0 = Date.now();
b.on("backend_lost", () => {
  lost = true;
  lostAt = Date.now() - t0;
});

// initial connect rejects (nothing listening); background reconnection continues
await b.connect().catch(() => {});

// wait comfortably past the give-up window
await new Promise((r) => setTimeout(r, 800));

if (!lost) {
  console.log("FAIL: backend_lost was never emitted — the client would spin forever");
  process.exit(1);
}
console.log(`PASS backend_lost emitted after ~${lostAt}ms (give-up = 250ms)`);

// close() must be idempotent and safe after give-up
b.close();
b.close();
console.log("PASS close() is idempotent");

console.log("\nOK client bounds reconnects and gives up (no immortal spinner).");
process.exit(0);
