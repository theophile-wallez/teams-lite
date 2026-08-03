// Extraction of the embedded web bundle for the compiled `teams` binary.
//
// In a `bun build --compile` standalone, the built web app (its runtime files +
// web/dist) is embedded as a single gzipped tarball asset and extracted to a
// stable cache path on the first launch — mirroring how the Rust backend binary is
// embedded and extracted (see backend.ts). Under `bun run` (dev) this module is
// never imported; the launcher uses the repo's web/ dir.
//
// The embedded asset (web.tar.gz) is produced by launcher/build.ts. Extraction uses the
// system `tar` (always present on Linux, teams-lite's only target) fed the archive
// on stdin, so we need no bundled tar parser.

import { spawnSync } from "bun";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/// Extract the embedded web bundle to ~/.cache/teams-lite/web and return that
/// directory. It contains server.ts (the Bun SSR server) plus the dist/ assets
/// it serves, laid out so server.ts resolves them relative to itself. Re-extracts
/// only when the embedded archive differs (size change), so upgrades refresh it
/// while normal launches are a cheap stat().
export async function extractEmbeddedWeb(): Promise<string> {
  const { default: bunfsPath } = await import("./embedded-web");
  const bytes = new Uint8Array(await Bun.file(bunfsPath).arrayBuffer());

  const dir = join(homedir(), ".cache", "teams-lite", "web");
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, ".archive-size");
  const entry = join(dir, "server.ts");

  let upToDate = false;
  try {
    upToDate =
      existsSync(entry) &&
      statSync(stamp).isFile() &&
      Number(readFileSync(stamp, "utf8")) === bytes.byteLength;
  } catch {
    upToDate = false;
  }

  if (!upToDate) {
    const result = spawnSync(["tar", "-xzf", "-", "-C", dir], {
      stdin: bytes,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (!result.success) {
      const err = result.stderr ? new TextDecoder().decode(result.stderr) : "unknown error";
      throw new Error(`failed to extract embedded web bundle: ${err}`);
    }
    writeFileSync(stamp, String(bytes.byteLength));
  }

  if (!existsSync(entry)) {
    throw new Error(`web bundle extracted but server entry missing at ${entry}`);
  }
  return dir;
}
