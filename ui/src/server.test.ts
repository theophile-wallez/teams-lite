// Test: ensureServer() spawns the Rust backend and waits until it's listening.
import { ensureServer } from "./server";

const t0 = Date.now();
const handle = await ensureServer();
console.log(`✅ backend ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// prove we can actually talk to it
const { Backend } = await import("./client");
const b = new Backend();
await b.connect();
const convs = await b.conversations();
console.log(`✅ ${convs.length} conversations via the spawned backend`);

handle.stop();
await Bun.sleep(300);
console.log("✅ backend stopped cleanly (stop()).");
process.exit(0);
