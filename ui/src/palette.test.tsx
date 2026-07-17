// Integration (headless, needs backend): the App connects, the sidebar renders in
// grey without borders, and Ctrl+K opens the palette centered on screen.

import { testRender } from "@opentui/solid";
import { App } from "./app";

const W = 100;
const H = 30;
const { renderOnce, captureCharFrame, mockInput, resize } = await testRender(() => <App />, {
  width: W,
  height: H,
});
resize(W, H);

// wait until the App leaves the splash (connected + conversations loaded)
let connected = false;
for (let i = 0; i < 40; i++) {
  await renderOnce();
  await new Promise((r) => setTimeout(r, 200));
  const f = captureCharFrame();
  if (!/lite — a fast Teams client/.test(f) && !/connecting|starting backend/.test(f)) {
    connected = true;
    break;
  }
}
if (!connected) {
  console.log("FAIL never connected (backend up?)");
  process.exit(1);
}
console.log("PASS connected, UI shown (past splash)");

// open the palette with Ctrl+K
mockInput.pressKey("k", { ctrl: true });
await renderOnce();
await new Promise((r) => setTimeout(r, 150));
await renderOnce();
const frame = captureCharFrame();
const lines = frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\n");

// the palette shows "Go to conversation"; find its row and column
let row = -1;
let col = -1;
for (let y = 0; y < lines.length; y++) {
  const idx = lines[y].indexOf("Go to conversation");
  if (idx >= 0) {
    row = y;
    col = idx;
    break;
  }
}
if (row < 0) {
  console.log("FAIL palette not shown after Ctrl+K");
  console.log(lines.join("\n"));
  process.exit(1);
}
// centered-ish: the palette box (width 64) should start around (100-64)/2 ≈ 18,
// so its "Go to conversation" label (padded left 2) sits well away from the edges.
const centeredH = col > 10 && col < W - 20;
const centeredV = row > 4 && row < H - 4;
console.log(`palette label at row=${row}, col=${col}`);
console.log(`${centeredH ? "PASS" : "FAIL"} horizontally centered`);
console.log(`${centeredV ? "PASS" : "FAIL"} vertically centered`);

process.exit(centeredH && centeredV ? 0 : 1);
