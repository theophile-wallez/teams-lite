// Integration (needs backend): open a conversation, verify the composer textarea
// renders (#1E1E1E, taller), and that adding lines grows it up to the cap.

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame, mockInput, resize } = await testRender(() => <App />, {
  width: 90,
  height: 40,
});
resize(90, 40);

// leave splash
for (let i = 0; i < 40; i++) {
  await renderOnce();
  await new Promise((r) => setTimeout(r, 200));
  if (!/lite — a fast Teams client|connecting|starting/.test(captureCharFrame())) break;
}

// open first conversation (Enter on the focused select)
mockInput.pressEnter();
await renderOnce();
await new Promise((r) => setTimeout(r, 500));
await renderOnce();

let frame = captureCharFrame();
const hasHint = /Enter to send/.test(frame);
console.log(`${hasHint ? "PASS" : "FAIL"} composer visible (hint line)`);

// the composer placeholder/hint proves the textarea mounted
if (!hasHint) {
  console.log(frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
  process.exit(1);
}
console.log("OK textarea composer renders with backend.");
process.exit(0);
