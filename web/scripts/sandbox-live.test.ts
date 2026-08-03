// The pin, tested. `scripts/sandbox-live.ts` is allowed to type into the user's real
// Teams account, so the properties that keep it harmless are the ones worth pinning:
// it targets one thread, it names that thread the same way AGENTS.md does, it cannot
// be aimed anywhere else, and no path inside it reaches a keypress without proving
// where the keypress lands.
//
// These are source-level checks on purpose. The runtime half needs a browser and a
// signed-in account, which no test may have — so what a test *can* hold is the shape
// of the file: constants instead of parameters, one navigation, two proofs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SANDBOX_PATH,
  SANDBOX_THREAD,
  SANDBOX_URL,
  SANDBOX_URL_LOCAL,
  TAILNET_ORIGIN,
} from "./sandbox-live";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPTS_DIR, "..", "..");
const SOURCE = readFileSync(join(SCRIPTS_DIR, "sandbox-live.ts"), "utf8");
const AGENTS_MD = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

/** The body of a top-level `function name(...)`, up to the closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `no function ${name} in sandbox-live.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

describe("the sandbox chat the live driver is pinned to", () => {
  it("is the one AGENTS.md designates", () => {
    // Two files naming the same thread is how the doc and the driver drift apart, so
    // the driver's constant has to appear in the doc verbatim.
    expect(
      AGENTS_MD.includes(SANDBOX_THREAD),
      `AGENTS.md does not name ${SANDBOX_THREAD}: the sandbox chat moved in one place ` +
        `and not the other.`,
    ).toBe(true);
    expect(AGENTS_MD).toContain(SANDBOX_URL);
    expect(AGENTS_MD).toContain(SANDBOX_URL_LOCAL);
  });

  it("routes to that thread and to nothing else", () => {
    expect(SANDBOX_PATH).toBe("/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2");
    expect(SANDBOX_URL).toBe(`${TAILNET_ORIGIN}${SANDBOX_PATH}`);
    expect(SANDBOX_URL_LOCAL.endsWith(SANDBOX_PATH)).toBe(true);
  });
});

describe("the ways this driver could be aimed elsewhere", () => {
  it("takes no url, thread, port or environment override", () => {
    for (const escape of ["--url", "--thread", "--front ", "process.env", "TEAMS_LITE_"]) {
      expect(
        SOURCE.includes(escape),
        `sandbox-live.ts mentions "${escape}" — the target must stay a constant, or the ` +
          `next caller can point a live send at any conversation.`,
      ).toBe(false);
    }
  });

  it("navigates exactly once, to the pinned url", () => {
    const navigations = SOURCE.match(/\.goto\(/g) ?? [];
    expect(navigations).toHaveLength(1);
    expect(SOURCE).toContain("page.goto(url, { waitUntil: \"domcontentloaded\" })");
  });

  it("hands the caller no page to navigate away with", () => {
    const session = SOURCE.slice(
      SOURCE.indexOf("export type SandboxLiveSession"),
      SOURCE.indexOf("\n};", SOURCE.indexOf("export type SandboxLiveSession")),
    );
    expect(session).not.toMatch(/\bpage\s*[?:]/);
    expect(session).not.toContain(": Page");
  });

  it("never lowers the TLS bar on the tailnet front", () => {
    expect(SOURCE).not.toContain("ignoreHTTPSErrors");
    expect(TAILNET_ORIGIN.startsWith("https://")).toBe(true);
  });
});

describe("the proof that precedes a keystroke", () => {
  it("re-reads the app's own conversation id, not the url", () => {
    const gate = functionBody(SOURCE, "assertSandboxThread");
    expect(gate).toContain('data-testid="composer-shell"');
    expect(gate).toContain('getAttribute("data-conversation-id"');
    expect(gate).toContain(`open === SANDBOX_THREAD`);
    // A missing sentinel must fail like a wrong one: `null` is "unproven", and
    // unproven means live (AGENTS.md § Automation safety).
    expect(gate).toContain("throw new Error(");
  });

  it("asserts before typing and again before Enter", () => {
    const typing = functionBody(SOURCE, "typeInSandbox");
    const checks = typing.match(/assertSandboxThread\(page, url\)/g) ?? [];
    expect(
      checks.length,
      `typeInSandbox must re-assert the thread twice — once before the text goes in, ` +
        `once immediately before Enter — and it asserts ${checks.length} time(s).`,
    ).toBe(2);
    // The second check has to sit before the keypress, not after it.
    const lastCheck = typing.lastIndexOf("assertSandboxThread(page, url)");
    expect(lastCheck).toBeLessThan(typing.indexOf('keyboard.press("Enter")'));
  });

  it("sends only when asked to", () => {
    const typing = functionBody(SOURCE, "typeInSandbox");
    expect(typing).toContain("if (!opts.send) return;");
  });
});
