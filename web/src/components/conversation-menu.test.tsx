/**
 * THE RULES OF THE MENU'S SPAWN ROW THAT ONLY THE SOURCE CAN ANSWER.
 *
 * Everything about WHETHER that row is drawn is `petSpawnIsOffered` (lib/pet-act.ts) and is pinned by
 * ordinary unit tests over that function, which is why it is a function. What is left is the WIRING —
 * the row is gated on the pending entry, its refusal is read back under the id the publish minted,
 * and it is never armed — and none of it is reachable here: a Radix menu renders no content while it
 * is closed, this suite's environment is `node`, and `ConversationMenu` holds its own `open`. So they
 * are scanned, in the discipline `pet-layer.test.tsx` and `engine-file.test.ts` already use.
 *
 * **A SCAN PROVES A SPELLING AND NOTHING ELSE.** That the row really refuses a second press, that the
 * sentence really appears where the press was made, and that the menu really closes on a spawn that
 * worked are facts about a mounted page and belong to the E2E spec. Each assertion below was verified
 * BY MUTATION — delete or invert the thing it names, watch this file go red, restore — because that
 * is the only thing that tells a scan that pins a rule from one satisfied by the wrong text.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = new URL(".", import.meta.url).pathname;

/**
 * The file with every comment stripped.
 *
 * Every rule below is ARGUED in prose right beside itself, so a scan that read the argument would
 * pass on the sentence describing the bug. The line-comment regex is UNANCHORED, mirroring
 * `pet-layer.test.tsx`'s own: an anchored one strips a comment on a line of its own and leaves a
 * TRAILING one, which is a measured way for a deleted guard to keep passing while it is quoted
 * beside its own grave.
 */
const menu = readFileSync(join(HERE, "conversation-menu.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * From a marker to the next `data-testid=` in the file.
 *
 * The window ENDS AT THAT MARKER rather than at a character count, because a fixed window from one
 * row reached the next row's identical `disabled=` and left a deleted guard green (measured, on the
 * pet menu's own rows). It is the one bound this file has that the text inside a window cannot
 * itself contain: one element's JSX carries exactly one `data-testid=`, and the handler this is used
 * for below carries none at all.
 */
function windowFrom(marker: string): string {
  const at = menu.indexOf(marker);
  expect(at, `${marker} is in the menu`).toBeGreaterThan(-1);
  const next = menu.indexOf("data-testid=", at + marker.length);
  return menu.slice(at, next === -1 ? undefined : next);
}

/**
 * The ARGUMENTS of one top-level call, from its opening line to its own `\n  });`.
 *
 * A call's arguments cannot contain that terminator, which is what makes it a bound — and the
 * looser `data-testid=` bound is measurably not one here: it ran past this call and matched an
 * identical argument spelling in a later statement, so a mutation of the real one passed.
 */
function callArgs(opening: string): string {
  const at = menu.indexOf(opening);
  expect(at, `${opening} is in the menu`).toBeGreaterThan(-1);
  const end = menu.indexOf("\n  });", at + opening.length);
  expect(end, `${opening} is closed`).toBeGreaterThan(-1);
  return menu.slice(at, end);
}

/**
 * One element's JSX.
 *
 * The marker carries its own closing quote AND the newline after it, and that is load-bearing
 * rather than decorative: weakened to `data-testid="${testid}`, a FULLY DELETED row passed an
 * assertion about itself, because the prefix resolved to `pet-spawn-error`.
 */
function element(testid: string): string {
  return windowFrom(`data-testid="${testid}"\n`);
}

describe("the spawn row, scanned", () => {
  it("is drawn from `petSpawnIsOffered` rather than from a gate of its own", () => {
    // Without this the four refusals could be unit-tested and unused — the row's own condition being
    // a second, untested spelling of them.
    expect(menu).toContain("const spawnOffered = petSpawnIsOffered({");
    expect(menu).toContain("{spawnOffered && (");
  });

  it("gates the press on the pending ENTRY, never on its act", () => {
    // `?.act` is NULL for a spawn, exactly as it is for a despawn and a skin change: those are the
    // presses with no optimistic draw, so a check written that way leaves a live control that is
    // pressed and inert, with no sentence and no cue. THE TERMINATOR IS PART OF THE ASSERTION —
    // without the `;` this is a prefix check, satisfied by `… !== undefined && petPending.act !== null;`,
    // which is byte for byte the defect the rule exists to prevent.
    expect(menu).toContain("const petBusy = petPending !== undefined;");
    expect(menu).not.toContain("petPending?.act");
    // AND THE GATE CARRIES A LEADING SPACE, which is what makes it the `disabled` PROP rather than a
    // word ending in it: `aria-disabled={…}` contains `disabled={…}` by substring and leaves the row
    // LIVE, because Radix reads only the `disabled` prop and `dropdown-menu.tsx` styles
    // `data-[disabled]`, which Radix sets from that prop alone. Do not simplify the space away.
    expect(element("pet-spawn")).toContain(" disabled={petBusy || spawnTravelling}");
  });

  it("stays OUT until the spawn's own ledger has reached this page", () => {
    // The window `petBusy` cannot cover: a spawn is the one publish here that is a `send`, and the
    // backend's send arm neither writes the row nor emits — so the pending slot is released while
    // `props.pets` still holds no creature of ours, and the row would be drawn, enabled and saying
    // "Take a cat" for a round trip. A second press there is a second SEND, which the fold absorbs
    // whole: two arrival messages, one drawing no creature, and no control in this feature can ever
    // reach it again. WHETHER it is travelling is `petSpawnIsTravelling`, where all four of its
    // inputs are argued and unit-tested; what is scanned here is that this component really asks it,
    // and asks it with the CONVERSATION and the REFUSAL — dropping either one was a measured defect
    // that left a row permanently disabled with no sentence.
    //
    // THE WINDOW IS THE CALL, bounded by its own `\n  });`. Bounded at the next `data-testid=`
    // instead, it ran past the call and reached `setSpawnedPet({ conversation: props.conversationId,
    // … })` — so swapping the argument for a constant PASSED (measured). A window is only a window
    // when the text inside it cannot contain the bound: these four arguments hold no `});`.
    const asks = callArgs("const spawnTravelling = petSpawnIsTravelling({");
    expect(asks).toContain("receipt: spawnedPet,");
    expect(asks).toContain("conversation: props.conversationId,");
    expect(asks).toContain("pets: props.pets,");
    expect(asks).toContain("refused: spawnError !== undefined,");
  });

  it("keeps the receipt SCOPED to the conversation the press was made in", () => {
    // This component is mounted unkeyed (`message-pane.tsx`, inside `{openId && …}`), so walking to
    // another chat re-renders the same instance with a new `conversationId`. A bare pet id therefore
    // read as "a spawn is travelling" in every other conversation the reader opened, for the life of
    // the page — worse than the one-round-trip window it replaced.
    expect(menu).toContain("setSpawnedPet({ conversation: props.conversationId, pet: publish.pet });");
    // And the SENTENCE is read only where the receipt was written, or one chat's refusal would be
    // drawn in another.
    expect(menu).toContain("spawnedPet && spawnedPet.conversation === props.conversationId");
  });

  it("writes the receipt ONCE and resets it nowhere — which is what its comments claim", () => {
    // A reset ANYWHERE re-opens the window on the RETURN path, not only on the close: press in A,
    // switch to B (the receipt's conversation no longer matches, so B's row is live — correct), a
    // reset fires, come back to A before the echo, and A's row is live again and says "Take a cat".
    // The scoping is the pure function's `receipt.conversation !== conversation` check, and it needs
    // no help. This is asserted as a COUNT rather than as a whole-file `not.toContain("…(null)")`,
    // which is the spelling that once forbade its own repair — a count says the true thing (one
    // write, no clear) without forbidding a shape a later reader may need for another reason.
    expect(menu.match(/setSpawnedPet\(/g)).toHaveLength(1);
  });

  it("writes the receipt BEFORE the publish it is the receipt for", () => {
    // Measured: moving `setSpawnedPet(...)` below `await controller.publishPetLedger(...)` passes
    // 49 of 49 unit tests, because it still lands in the same React batch — the continuation of a
    // resolved promise. That is a fact about React 18's batching rather than about this component,
    // and the window it would open is the duplicate-send window this receipt exists to close: the
    // `send` arm answers before the message reaches the page, so a press inside it mints a fresh
    // id and posts a SECOND ledger the fold absorbs whole. Three rounds went into closing it, so
    // the ORDER is pinned rather than left resting on a batching guarantee nothing here states.
    const receipt = menu.indexOf("setSpawnedPet(");
    const publish = menu.indexOf("await controller.publishPetLedger(");
    expect(receipt).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    expect(receipt).toBeLessThan(publish);
  });

  it("does not drop the receipt when the MENU closes, which is the event the window opens on", () => {
    // A reset there erased the only memory of a spawn that had just gone out and handed the row
    // straight back. The window is `onOpenChange`'s own handler — bounded at the next
    // `data-testid=`, which that handler cannot contain — rather than the whole file: a
    // whole-file `not.toContain` would also forbid the effect-based reset a later reader may need
    // (`useEffect(() => setSpawnedPet(null), [props.conversationId])`), and a red suite reads as
    // "this is wrong" rather than "this is already handled another way".
    expect(windowFrom("onOpenChange={(next) => {")).not.toContain("setSpawnedPet");
  });

  it("is ONE press and is never armed", () => {
    // Asking twice is reserved for what nothing undoes — Remove, a deletion, the merge. A spawn is
    // taken back from the creature's own menu, and a confirmation on something reversible teaches the
    // reader that this app's confirmations mean nothing. The window is this row's own, so an armed
    // control somewhere else in this menu could not satisfy it.
    expect(element("pet-spawn")).not.toContain("armed");
  });

  it("keeps the MINTED pet from the publish, and reads the refusal back under it", () => {
    // A first spawn's `publish.pet` is an id this menu has never seen — the pets it holds by
    // definition do not carry it yet — so a sentence keyed by anything read off them would be a
    // refusal reported nowhere. `petPublishFor` is what mints it, and it is kept from that answer.
    expect(menu).toContain("pet: publish.pet }");
    expect(menu).toContain("s.petError[petSlotKey(spawnedPet.conversation, spawnedPet.pet)]");
  });

  it("mints no id of its own and reads no ledger — `petPublishFor` decides the whole publish", () => {
    // A component that minted one would re-mint a pet its owner had sent home, which the wire's own
    // rule forbids: an id is minted once and kept, so a creature taken back is the same creature
    // rather than a stranger wearing its skin.
    expect(menu).not.toContain("newPetId");
    expect(menu).toContain('petPublishFor({\n      press: { kind: "spawn", skin: petSkinName },');
  });
});
