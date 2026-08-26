// What the page's OWN notification says about a message — and specifically that its body goes
// through the same strip a sidebar row does.
//
// This is a SOURCE SCAN, which is the weaker kind of assertion, and it is here because there is no
// weaker-still option: the body is built inside the store's live-message handler, which needs a
// whole controller to drive, while the strip itself (`withoutWireLine`) is pure and pinned by its
// own tests in protocol.test.ts. What this adds is the half those cannot reach — that the handler
// really calls it — and this surface is exactly the one that was MISSED when the other three were
// given the rule, so it is worth pinning by the means available.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `store.ts` with its `//` COMMENTS DROPPED.
 *
 * A scan cannot tell code from prose, and this one was defeated by exactly that: commenting the
 * call out and writing the plain one under it left the deleted line quoted in the window and the
 * suite green — with a colleague's pet spawn popping a wire dump. There is a live comment block
 * inside this very window naming both `withoutWireLine` and `copyableMessageText`, so it is not a
 * hypothetical either. It is the rule the Rust siblings hold
 * (`teams_members`, `teams_presence`, `teams_chat_settings`: `!line.trim_start().starts_with("//")`).
 */
const STORE = readFileSync(join(import.meta.dirname, "store.ts"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("the page's own notification", () => {
  it("builds its body through the wire strip", () => {
    // The window is bounded by two lines whose text cannot appear inside it: the gate above it
    // and the cue below it. Both ends are asserted, so a marker that moved or was renamed fails
    // here rather than silently widening the window to the whole file.
    const from = STORE.indexOf("shouldNotify(m, this.get().openId");
    const to = STORE.indexOf('playCue("droplet")');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const window = STORE.slice(from, to);

    // The exact spelling that does the work. `copyableMessageText` alone is the whole body of the
    // message, so a colleague's pet spawn or chess challenge popped a notification carrying the
    // machine-readable line the reader must never be shown.
    expect(window).toContain("notifyMessage(m.sender, withoutWireLine(copyableMessageText(m))");

    // AND THE NEGATIVE IS WHAT REALLY DOES THE WORK, because a scan cannot tell code from prose and
    // the filter above only knows ONE spelling of a comment. `/* … */` around the stripped call with
    // the plain one under it defeats `startsWith("//")` — measured — while this line catches both,
    // and every other way of writing the unstripped call besides. The positive assertion above still
    // earns its place: it is what fails when the call is replaced by some THIRD spelling that stops
    // stripping without being this exact one.
    expect(window).not.toContain("notifyMessage(m.sender, copyableMessageText(m)");
  });

  it("leaves COPY alone", () => {
    // Copying a message hands the reader the message as it really is. The two uses of
    // `copyableMessageText` outside that window are the copy actions, and neither strips.
    const to = STORE.indexOf('playCue("droplet")');
    expect(STORE.slice(to)).toContain("copyableMessageText(message)");
    expect(STORE.slice(to)).not.toContain("withoutWireLine");
  });
});
