// Hugeicons is the app's one icon library. Nothing enforces that at build time —
// a second icon package installs and compiles perfectly well — so these tests scan
// the source tree the way the mail and calendar write-locks scan theirs: the rule
// lives in code, not only in a review comment.
//
// Why one library at all: two sets never match. Their glyphs sit on different grids,
// carry different stroke weights and round their corners differently, so a row that
// mixes them reads as two designs sharing a screen. The app used lucide-react before
// 2026-08-03 and now draws every glyph from @hugeicons/core-free-icons.
/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_DIRS = ["src", "scripts", "mock", "e2e"];

/** The icon library every glyph in this app comes from. */
const ICON_PACKAGE = "@hugeicons/core-free-icons";

/** Icon libraries this app deliberately does NOT carry. A package that only ships
 *  a logomark (a brand asset) is not an icon library and is not listed. */
const BANNED_PACKAGES = [
  "lucide-react",
  "react-icons",
  "@heroicons/react",
  "@radix-ui/react-icons",
  "@tabler/icons-react",
  "react-feather",
];

/** Every TypeScript source file under the app's own directories — except this
 *  guard, which names the banned packages in order to ban them. */
function sourceFiles(): string[] {
  const self = fileURLToPath(import.meta.url);
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a directory this checkout does not have
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && path !== self) {
        found.push(path);
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(WEB_DIR, dir));
  return found;
}

describe("the icon library", () => {
  it("finds the source files it is meant to scan", () => {
    // A guard whose glob silently matched nothing would pass forever.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("is the only one imported anywhere in the app", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      const source = readFileSync(path, "utf8");
      for (const banned of BANNED_PACKAGES) {
        if (source.includes(`"${banned}"`) || source.includes(`'${banned}'`)) {
          offenders.push(`${path.slice(WEB_DIR.length + 1)} imports ${banned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is the only one installed", () => {
    const pkg = JSON.parse(readFileSync(join(WEB_DIR, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(installed).filter((name) => BANNED_PACKAGES.includes(name))).toEqual([]);
    expect(installed[ICON_PACKAGE]).toBeTruthy();
    expect(installed["@hugeicons/react"]).toBeTruthy();
  });
});
