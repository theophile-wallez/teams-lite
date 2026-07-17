// Integration (needs backend): the conversation list scrolls with the wheel and
// shows a scrollbar handle; clicking a row opens it.

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame, mockMouse, resize } = await testRender(() => <App />, {
  width: 90,
  height: 20, // small height so 588 conversations overflow and the scrollbar shows
});
resize(90, 20);

for (let i = 0; i < 40; i++) {
  await renderOnce();
  await new Promise((r) => setTimeout(r, 200));
  if (!/lite — a fast Teams client|connecting|starting/.test(captureCharFrame())) break;
}

// capture the top-of-list frame, then wheel-scroll down inside the sidebar
const top = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const firstRowsTop = top.split("\n").slice(1, 6).join("|");

await mockMouse.scroll(4, 10, "down");
await mockMouse.scroll(4, 10, "down");
await mockMouse.scroll(4, 10, "down");
await renderOnce();
await new Promise((r) => setTimeout(r, 200));
await renderOnce();

const after = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const firstRowsAfter = after.split("\n").slice(1, 6).join("|");

const scrolled = firstRowsTop !== firstRowsAfter;
console.log(`${scrolled ? "PASS" : "FAIL"} wheel scrolled the conversation list`);

// click a visible row to open it
await mockMouse.click(4, 3);
await renderOnce();
await new Promise((r) => setTimeout(r, 400));
await renderOnce();
const opened = /Enter to send/.test(captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
console.log(`${opened ? "PASS" : "FAIL"} click opened a conversation`);

process.exit(scrolled && opened ? 0 : 1);
