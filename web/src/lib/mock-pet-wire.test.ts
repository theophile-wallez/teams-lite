/**
 * THE PET WIRE AS THE MOCK SPELLS IT (`web/mock/server.ts`, the "A PET, answered" block).
 *
 * That block re-implements the line a pet message signs itself with rather than importing this
 * directory's `pet-wire.ts`, on purpose: it stands for ANOTHER MACHINE, so a divergence between the
 * two spellings has to fail a test rather than be impossible. This is the test it has to fail.
 *
 * **EVERY EXPECTATION IS DERIVED FROM THE PAGE, and never typed in here.** A copy of the vocabulary
 * in this file would only pin the mock against a third spelling — change `ACT_TO_WIRE` on the page
 * and a test full of literals still passes, so every pet spec would then pass against a fiction,
 * which is exactly what the duplication exists to prevent. So the page's own exports are read where
 * it exports them (`PET_SKIN`, `PET_ACTS_KEPT`, `PET_PAT_KEY`) and everything else is taken from what
 * `serializePetLedger`, `petMessageHtml` and `petMessageWords` actually EMIT.
 *
 * It SCANS the mock's source instead of calling its functions, for the reason `engine-file.test.ts`
 * scans: `mock/server.ts` calls `Bun.serve` and `startLiveFeed()` at module scope, so it cannot be
 * imported into a vitest run at all. Where a rule cannot be pinned by containment the mock's OWN
 * regex is lifted out of that source and run against what the page emitted, which is the strongest
 * form available here: the page writes the bytes, the mock's parser reads them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PET_PAT_KEY } from "./pet-thread";
import { petSkin } from "./pet-skin";
import {
  PET_ACT,
  PET_ACTS_KEPT,
  PET_SKIN,
  petMessageHtml,
  petMessageWords,
  serializePetLedger,
  type PetAct,
  type PetLedger,
} from "./pet-wire";

const HERE = new URL(".", import.meta.url).pathname;
const SOURCE = readFileSync(join(HERE, "..", "..", "mock", "server.ts"), "utf8");
/** The source with its comments taken out — that block explains the colon rule in its own prose, and
 *  a scan that read the prose would fail on the sentence stating the rule it is checking. Unanchored,
 *  mirroring `src/vendor/desksprite.test.ts`'s own `code()`: a TRAILING comment is a comment, and every
 *  `toContain(CODE, …)` below would otherwise be satisfiable by one quoting the constant it names. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** One top-level function's BODY, signature excluded: the signature carries type annotations, whose
 *  colons say nothing about what the function writes. Every function in that block is top-level, so
 *  the body ends at the first line that is exactly `}`.
 *
 *  BOTH ENDS ARE ASSERTED, which is the rule `pet-act.test.ts`'s own bounding helper states: an
 *  `indexOf` that finds nothing answers -1, and `slice` then reads that as "one from the end" and
 *  silently runs the window to the end of the file. Those two are the rule's spelling and are
 *  unreachable in THIS file — some `{\n` and some `\n}` always follow a function in a 12 000-line
 *  source — and the assertion below is an absence anyway, so either would present as a false failure.
 *  They are written because one window quietly exempt from the rule its sibling states is how the next
 *  reader learns the rule is optional.
 *
 *  WHAT IS REACHABLE IS THE OVER-RUN, at EITHER end, and both are measured. Indenting the
 *  serializer's own closing brace made `indexOf` find a later function's, so the window ran over three
 *  more; re-writing a body onto its signature's own line took the OPENING to the next function's
 *  brace, so the window was another function's body entirely. Each failed on the colon rule, naming a
 *  function nobody had touched — a bound resolved to somebody else's brace has bounded nothing. So the
 *  opening must be this signature's own and the window must hold one declaration. */
function bodyOf(name: string): string {
  const at = CODE.indexOf(`function ${name}(`);
  expect(at, `${name} is not in mock/server.ts`).toBeGreaterThan(-1);
  const opens = CODE.indexOf("{\n", at);
  // The brace has to be THIS signature's own, and a signature here is one line — which is what tells
  // a miss (-1, so a slice of most of the file) and a hit on the NEXT function's brace apart from a
  // real one: both put a newline between the name and the brace.
  expect(CODE.slice(at, opens), `${name} still opens its own body in mock/server.ts`).not.toContain("\n");
  const closes = CODE.indexOf("\n}", opens);
  expect(closes, `${name}'s body still closes at column 0 in mock/server.ts`).toBeGreaterThan(opens);
  const body = CODE.slice(opens, closes);
  expect(body, `${name}'s window holds only ${name}`).not.toContain("\nfunction ");
  return body;
}

/** Every regex the mock READS the wire with inside one function, in source order — lifted out so it
 *  can be run against bytes the page really wrote. */
function readersIn(body: string): RegExp[] {
  const literals = body.matchAll(/(\/(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[a-z]*)\.exec\(/g);
  return [...literals].map((match) => {
    const source = match[1] ?? "";
    const closes = source.lastIndexOf("/");
    return new RegExp(source.slice(1, closes), source.slice(closes + 1));
  });
}

/** The skin the mock's own colleague wears, which is the one value it STATES where the page DERIVES
 *  one (`labelOf` reads `petSkin(...).label`). Named once here so the label assertion below is about
 *  the page's answer for this skin rather than about a word. */
const COLLEAGUE_SKIN = "duck";

const ACTS: PetAct[] = [
  { at: 1756060012345, kind: "feed", target: "7f3a1c" },
  { at: 1756060012346, kind: "play", target: "7f3a1c" },
  { at: 1756060012347, kind: "nap", target: "7f3a1c" },
];
/** A ledger with EVERYTHING set, so one serialization carries every token the wire has. */
const FULL: PetLedger = { pet: "abc123", skin: COLLEAGUE_SKIN, gone: false, acts: ACTS };
const PAYLOAD = serializePetLedger(FULL);
const TOKENS = PAYLOAD.split(" ");

describe("the ledger line the mock writes", () => {
  it("CARRIES NO COLON, in the serializer or in the line it becomes", () => {
    // The backend substitutes custom emoji into every outbound body, on a send and on an edit alike,
    // and `:name:` matches ANYWHERE in the text for any lowercase name in the reader's own pack —
    // which packs grow into on their own. An act written `1756060012345:f:7f3a1c` therefore holds the
    // code span `:f:`, becomes an `<img>`, breaks the signature the line lives inside, and every pet
    // in the conversation is unreadable for everybody for good, with nothing left to repair it with:
    // the app can no longer see a ledger to edit. `pet-wire.test.ts` pins the page's half of exactly
    // this, and the mock is the other machine. Both functions are written free of a colon anywhere so
    // that this scan can be blunt.
    expect(bodyOf("mockSerializePetLedger")).not.toContain(":");
    expect(bodyOf("mockPetLedgerLine")).not.toContain(":");
  });

  it("keeps the page's own ENVELOPE and its `— pet <id> …` line", () => {
    // Neither `SIGNATURE` nor `PET_LINE` is exported, so the mock's own two readers are run against a
    // body the PAGE built: three features sign a message in that envelope, and a mock that read a
    // fourth shape of it would find no creature in anything a real install ever posted.
    const [signature, line] = readersIn(bodyOf("mockPetWire"));
    const found = signature?.exec(petMessageHtml(FULL, petSkin(COLLEAGUE_SKIN).label));
    expect(found, "the mock's envelope does not match what petMessageHtml writes").not.toBeNull();
    const read = line?.exec((found?.[1] ?? "").trim());
    expect(read, "the mock's line does not match what petLedgerLine writes").not.toBeNull();
    expect(read?.[1]).toBe(FULL.pet);
    expect((read?.[2] ?? "").trim()).toBe(PAYLOAD);
  });

  it("opens a payload with the page's own VERSION token", () => {
    // A version the mock did not know would leave every colleague's ledger an ordinary message —
    // which is the right rule for a NEWER build and a silent bug for the current one.
    expect(CODE).toContain(`MOCK_PET_LEDGER_VERSION = ${JSON.stringify(TOKENS[0])}`);
  });

  it("holds the page's own ACT pattern, and maps each letter back to the same kind", () => {
    // The PATTERN is asserted by EQUALITY rather than by acceptance, which is why `PET_ACT` is
    // exported: a mock regex loosened to `\d+` still accepts every token the page writes, so a test
    // that only fed it real bytes would pass over exactly the drift this duplication exists to
    // catch. The letters are then taken from those bytes and both of the mock's maps pinned against
    // them — the one vocabulary whose divergence is silent, since a letter of its own reads as a
    // colleague whose creature nothing can be done to rather than as a mock with a typo in it.
    expect(CODE).toContain(PET_ACT.source);
    const letters: Record<string, string> = {};
    for (const wanted of ACTS) {
      const token = TOKENS.find((it) => it.startsWith(`${wanted.at}.`)) ?? "";
      // `<at>.<letter>.<target>`, so the outer two are checked to earn the middle one.
      const [at, letter, target] = token.split(".");
      expect(at, token).toBe(String(wanted.at));
      expect(target, token).toBe(wanted.target);
      letters[wanted.kind] = letter ?? "";
    }
    expect(CODE).toContain(
      `= { feed: "${letters.feed}", play: "${letters.play}", nap: "${letters.nap}" }`,
    );
    expect(CODE).toContain(
      `= { ${letters.feed}: "feed", ${letters.play}: "play", ${letters.nap}: "nap" }`,
    );
  });

  it("holds the page's SKIN charset, and reads the skin token it emits", () => {
    // Equality first, as for the act: exported for exactly this, since two spellings of one charset
    // drift the moment either is loosened. Then the mock's own reader over the page's own token,
    // which is the one thing containment cannot say — that the NAME comes out of capture 1.
    expect(CODE).toContain(PET_SKIN.source);
    const [, skin] = readersIn(bodyOf("mockParsePetLedger"));
    expect(skin?.exec(TOKENS[1] ?? "")?.[1]).toBe(COLLEAGUE_SKIN);
  });

  it("spells the GONE flag the page's way, in both directions", () => {
    // Derived as the token a gone ledger has and this one does not, so the word is the page's.
    const gone = serializePetLedger({ ...FULL, gone: true }).split(" ");
    const token = gone.find((it) => !TOKENS.includes(it)) ?? "";
    expect(CODE).toContain(`token === ${JSON.stringify(token)}`);
    expect(CODE).toContain(`parts.push(${JSON.stringify(token)})`);
  });

  it("bounds a record and names a pat with the page's own constants", () => {
    // The semicolon is load-bearing: an unquoted numeric prefix means a page value of 3 is satisfied
    // by a mock that says 30, which is the one assertion here guarding a BOUND.
    expect(CODE).toContain(`MOCK_PET_ACTS_KEPT = ${PET_ACTS_KEPT};`);
    expect(CODE).toContain(`MOCK_PET_PAT_KEY = ${JSON.stringify(PET_PAT_KEY)}`);
  });

  it("writes the WORDS the page writes, under the label the page DERIVES", () => {
    // The words are what a colleague on stock Teams reads and what a sidebar row previews, so a mock
    // that worded its own creature differently would be the one field nothing held to anything.
    const label = petSkin(COLLEAGUE_SKIN).label;
    expect(CODE).toContain(`MOCK_PET_LABEL = ${JSON.stringify(label)}`);
    // `"fed"` here is a LOCATOR for the separator around it rather than an expectation — the words
    // themselves are asserted below, off the page's own output, and a verb that moved fails there.
    const one = petMessageWords({ ...FULL, acts: [ACTS[0]!] }, "L");
    expect(CODE).toContain(JSON.stringify(one.slice(1, one.indexOf("fed"))));
    for (const piece of petMessageWords(FULL, label).split(" · ").slice(1)) {
      expect(CODE).toContain(JSON.stringify(piece.split(" ")[0]));
    }
    for (const sentence of [
      petMessageWords({ ...FULL, acts: [] }, ""),
      petMessageWords({ ...FULL, gone: true }, ""),
    ]) {
      expect(CODE).toContain(sentence.trim());
    }
  });
});
