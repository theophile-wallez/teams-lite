// Headless test: before the backend is ready, the App shows the splash (ASCII
// "teams" logo + a status line). Captured immediately, before any connection.

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame } = await testRender(() => <App />, { width: 80, height: 24 });
await renderOnce();
const frame = captureCharFrame();

// the ASCII "teams" logo renders large; the "lite" subtitle + a status line show too
const checks: [string, boolean][] = [
  ["lite subtitle", frame.includes("lite")],
  ["status line", /starting backend|connecting/.test(frame)],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
}
if (!ok) {
  console.log("\n--- frame ---\n" + frame.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""));
  process.exit(1);
}
console.log("\nOK splash renders before the backend is ready.");
process.exit(0);
