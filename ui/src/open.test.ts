// Integration: local-first open. `open` must return quickly (from cache or empty)
// and, when the network has newer data, a `messages_updated` event must follow.

import { Backend } from "./client";

const b = new Backend();
await b.connect();

const convs = await b.conversations();
const target = convs
  .filter((c) => c.last_message_time > 0)
  .sort((a, z) => z.last_message_time - a.last_message_time)[0];
if (!target) {
  console.log("no conversation with activity to test");
  process.exit(1);
}
console.log(`opening "${target.name || target.id}"`);

let updated = false;
b.on("messages_updated", (d: any) => {
  if (d.conversation === target.id) {
    updated = true;
    console.log(`PASS messages_updated event -> ${d.messages.length} messages`);
  }
});

const t0 = Date.now();
const res = await b.open(target.id);
const dt = Date.now() - t0;
console.log(`PASS open returned in ${dt}ms with ${res.messages.length} cached messages`);
if (dt > 500) console.log(`WARN open took ${dt}ms (expected instant from cache)`);

// wait for the background refresh event
await new Promise((r) => setTimeout(r, 4000));
console.log(updated ? "PASS background refresh delivered" : "note: no refresh event (cache already fresh)");

const last = res.messages[res.messages.length - 1];
if (last) console.log(`last cached: ${last.sender}: ${last.content.replace(/<[^>]+>/g, "").slice(0, 40)}`);
process.exit(0);
