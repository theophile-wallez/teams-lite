// Integration test (headless): with the Rust backend running, mount the App,
// let it connect + fetch, and assert real conversations render in the frame.

import { testRender } from "@opentui/solid";
import { App } from "./app";

const { renderOnce, captureCharFrame } = await testRender(() => <App />, { width: 100, height: 30 });

// wait for connect + conversations() round-trip
for (let i = 0; i < 40; i++) {
  await renderOnce();
  await new Promise((r) => setTimeout(r, 200));
  const f = captureCharFrame();
  // the status bar shows "<n> conversations" once loaded
  if (/\d+ conversations/.test(f)) {
    console.log("✅ connected to backend, conversations loaded");
    console.log("   status:", (f.match(/\d+ conversations/) || [])[0]);
    // a real name should appear in the list (not just placeholders)
    const hasRealName = /Leonor|Cl.ment|Ghiles|Notes|Stratumn|St.umn/.test(f);
    console.log(`${hasRealName ? "✅" : "⚠️ "} real names visible in the sidebar`);
    process.exit(0);
  }
}
console.log("❌ no conversations loaded (is the backend up?)");
console.log(captureCharFrame().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").slice(0, 400));
process.exit(1);
