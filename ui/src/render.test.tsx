// Headless render test: mount the real App with OpenTUI test renderer (no TTY).
// Without a backend the App stays on the splash — assert it renders correctly and
// the tree is valid (graceful degradation).

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame, resize } = await testRender(() => <App />, {
  width: 100,
  height: 30,
});

resize(100, 30);
await renderOnce();
await new Promise((r) => setTimeout(r, 300));
await renderOnce();

const frame = captureCharFrame();

const checks: [string, boolean][] = [
  ["ascii logo", frame.includes("╗")],
  ["subtitle", frame.includes("lite")],
  ["status line", /connecting|starting backend/.test(frame)],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.log("\n--- frame ---\n" + frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
  process.exit(1);
}
console.log("\nOK App mounts and renders the splash (headless, no backend).");
process.exit(0);
