// The cache the compiled `teams` binary unpacks itself into, and the one question it has
// to get right: is what is already there the asset THIS binary carries?
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assetId,
  cachedAssetIsCurrent,
  forgetCachedAsset,
  replaceFile,
  stampCachedAsset,
} from "./embedded-cache";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teams-lite-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Two builds of one program: the same length, a byte apart. */
function twoBuildsOfOneSize(): [Uint8Array, Uint8Array] {
  const a = new Uint8Array(4096).fill(7);
  const b = new Uint8Array(4096).fill(7);
  b[1234] = 8;
  return [a, b];
}

describe("assetId", () => {
  // THE BUG THIS FILE EXISTS FOR. A Rust release binary's size is decided by section
  // alignment, so three consecutive builds of the backend weighed exactly 17 432 216
  // bytes. The launcher compared the count, kept the backend it already had, and the app
  // offered the same update for ever: the backend it ran was two commits behind the
  // launcher and the web bundle it was running beside.
  test("tells two builds of the same SIZE apart", () => {
    const [a, b] = twoBuildsOfOneSize();
    expect(a.byteLength).toBe(b.byteLength);
    expect(assetId(a)).not.toBe(assetId(b));
  });

  test("is the same for the same bytes, so an ordinary launch extracts nothing", () => {
    const [a] = twoBuildsOfOneSize();
    expect(assetId(a)).toBe(assetId(new Uint8Array(a)));
  });
});

describe("cachedAssetIsCurrent", () => {
  test("a stamp that is not there means extract", () => {
    expect(cachedAssetIsCurrent(join(dir, "missing"), "1-2")).toBe(false);
  });

  // What an older launcher wrote at .archive-size was a byte count. It must miss rather
  // than be read as an id, so the first launch on this code extracts once and moves on.
  test("a stamp in an older spelling means extract", () => {
    const stamp = join(dir, ".archive-size");
    writeFileSync(stamp, "22253729");
    expect(cachedAssetIsCurrent(stamp, assetId(new Uint8Array(22253729)))).toBe(false);
  });

  test("its own stamp matches, trailing newline included", () => {
    const [a] = twoBuildsOfOneSize();
    const stamp = join(dir, ".server-id");
    stampCachedAsset(stamp, assetId(a));
    expect(cachedAssetIsCurrent(stamp, assetId(a))).toBe(true);
    writeFileSync(stamp, `${assetId(a)}\n`);
    expect(cachedAssetIsCurrent(stamp, assetId(a))).toBe(true);
  });

  test("the stamp of another build misses", () => {
    const [a, b] = twoBuildsOfOneSize();
    const stamp = join(dir, ".server-id");
    stampCachedAsset(stamp, assetId(a));
    expect(cachedAssetIsCurrent(stamp, assetId(b))).toBe(false);
  });
});

describe("replaceFile", () => {
  // A RENAME, never a write into the file already there: this machine may be RUNNING the
  // backend at that path (the released unit and a `teams` command share one cache), and
  // rewriting the bytes of a running executable is how a process earns a SIGBUS.
  test("leaves the running copy's inode alone and moves a new one into place", () => {
    const [a, b] = twoBuildsOfOneSize();
    const dest = join(dir, "server");
    replaceFile(dest, a, 0o755);
    const first = statSync(dest).ino;

    replaceFile(dest, b, 0o755);
    expect(statSync(dest).ino).not.toBe(first);
    expect(Array.from(readFileSync(dest))).toEqual(Array.from(b));
  });

  test("the extracted backend is executable", () => {
    const dest = join(dir, "server");
    replaceFile(dest, new Uint8Array([1, 2, 3]), 0o755);
    expect(statSync(dest).mode & 0o777).toBe(0o755);
  });

  test("nothing is left beside it", () => {
    const dest = join(dir, "server");
    replaceFile(dest, new Uint8Array([1, 2, 3]), 0o755);
    expect(Array.from(new Bun.Glob("*").scanSync(dir))).toEqual(["server"]);
  });
});

describe("forgetCachedAsset", () => {
  test("a stamp that is not there is the normal case", () => {
    expect(() => forgetCachedAsset(join(dir, "missing"))).not.toThrow();
  });
});

// The two extractors must ask about CONTENT. A size comparison is the shape of the bug
// above, and it reads as a perfectly sensible optimisation — so it is pinned out here
// rather than left to a reviewer's memory.
describe("the extractors", () => {
  const sources = ["backend.ts", "web-bundle.ts"] as const;

  for (const name of sources) {
    const source = readFileSync(join(import.meta.dir, name), "utf8");

    test(`${name} decides freshness on the asset's id`, () => {
      expect(source).toContain("assetId(");
      expect(source).toContain("cachedAssetIsCurrent(");
    });

    test(`${name} never decides it on a byte count`, () => {
      expect(source).not.toMatch(/\.size\s*===/);
      expect(source).not.toMatch(/===\s*bytes\.byteLength/);
      expect(source).not.toMatch(/bytes\.byteLength\s*===/);
    });
  }

  // The backend is extracted with the rename above, not with a plain write: see the
  // SIGBUS reason on `replaceFile`.
  test("the backend is moved into place, never written over", () => {
    const source = readFileSync(join(import.meta.dir, "backend.ts"), "utf8");
    expect(source).toContain("replaceFile(dest,");
    expect(source).not.toContain("writeFileSync(dest,");
  });
});
