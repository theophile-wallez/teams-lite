// Regression test for the conversation-list freeze.
//
// The UI coalesces conversation-list refreshes so that a burst of events (or a
// backend feedback loop) can never fan out into many concurrent refetches that
// saturate the single-threaded UI event loop. `coalesce` must guarantee: at most
// ONE run in flight, and any triggers fired during that run collapse into exactly
// ONE trailing run — never a per-trigger stack.

import { coalesce } from "./singleflight";

// State lives on an object so the counter reads as a plain `number` (a bare
// `let` would let TS literal-narrow it across awaits and flag the comparisons).
const state: { runs: number; resolveCurrent: (() => void) | null } = {
  runs: 0,
  resolveCurrent: null,
};
const run = () =>
  new Promise<void>((resolve) => {
    state.runs++;
    state.resolveCurrent = resolve;
  });

const trigger = coalesce(run);
const count = () => state.runs;
const tick = () => new Promise((r) => setTimeout(r, 0));

// Fire three triggers while the first run is still in flight.
trigger();
trigger();
trigger();

if (count() !== 1) {
  console.log(`FAIL: expected exactly 1 run in flight, got ${state.runs} (triggers stacked)`);
  process.exit(1);
}
console.log("PASS 3 concurrent triggers -> only 1 run in flight");

// Completing the first run must start exactly ONE trailing run (coalescing the
// two triggers that arrived while it was busy), not two.
state.resolveCurrent!();
await tick();
if (count() !== 2) {
  console.log(`FAIL: expected 1 trailing run, got ${state.runs - 1}`);
  process.exit(1);
}
console.log("PASS the 2 queued triggers collapsed into 1 trailing run");

// Completing the trailing run with nothing queued must NOT start another run
// (this is what makes the loop terminate instead of spinning forever).
state.resolveCurrent!();
await tick();
if (count() !== 2) {
  console.log(`FAIL: run kept looping with nothing queued (runs=${state.runs})`);
  process.exit(1);
}
console.log("PASS no queued work -> loop settles (no runaway)");

// A fresh trigger after everything settled starts a new run.
trigger();
if (count() !== 3) {
  console.log(`FAIL: a trigger after settle should start a new run, got runs=${state.runs}`);
  process.exit(1);
}
state.resolveCurrent!();
console.log("PASS a trigger after settle starts a fresh run");

console.log("\nOK coalesce bounds concurrency to 1 + a single trailing pass.");
process.exit(0);
