// Integration (needs backend): open a conversation, type into the composer, and
// verify the typed text appears (asText coercion works, no crash).

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame, mockInput, resize } = await testRender(() => <App />, {
  width: 90,
  height: 40,
});
resize(90, 40);

for (let i = 0; i < 40; i++) {
  await renderOnce();
  await new Promise((r) => setTimeout(r, 200));
  if (!/lite — a fast Teams client|connecting|starting/.test(captureCharFrame())) break;
}

mockInput.pressEnter(); // open first conversation
await renderOnce();
await new Promise((r) => setTimeout(r, 400));

// type into the composer
await mockInput.typeText("hello world");
await renderOnce();
await new Promise((r) => setTimeout(r, 200));
await renderOnce();

const frame = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const typed = frame.includes("hello world");
console.log(`${typed ? "PASS" : "FAIL"} typed text visible in composer`);
if (!typed) {
  // show the composer region
  console.log(frame.split("\n").slice(-8).join("\n"));
  process.exit(1);
}
console.log("OK composer accepts input without crashing.");
process.exit(0);
