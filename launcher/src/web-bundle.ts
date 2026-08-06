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
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assetId,
  cachedAssetIsCurrent,
  forgetCachedAsset,
  stampCachedAsset,
} from "./embedded-cache";

/// Extract the embedded web bundle to ~/.cache/teams-lite/web and return that
/// directory. It contains server.ts (the Bun SSR server) plus the dist/ assets
/// it serves, laid out so server.ts resolves them relative to itself. Re-extracts
/// whenever the embedded archive is not the one already unpacked there — by its
/// CONTENT, exactly as the backend beside it (see embedded-cache.ts): a gzipped
/// tarball that happens to weigh what the last one weighed would otherwise serve
/// the previous build's app for ever.
export async function extractEmbeddedWeb(): Promise<string> {
  const { default: bunfsPath } = await import("./embedded-web");
  const bytes = new Uint8Array(await Bun.file(bunfsPath).arrayBuffer());

  const dir = join(homedir(), ".cache", "teams-lite", "web");
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, ".archive-id");
  const entry = join(dir, "server.ts");
  const id = assetId(bytes);

  const upToDate = existsSync(entry) && cachedAssetIsCurrent(stamp, id);

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
    stampCachedAsset(stamp, id);
    // The byte count an older launcher stamped here says nothing now.
    forgetCachedAsset(join(dir, ".archive-size"));
  }

  if (!existsSync(entry)) {
    throw new Error(`web bundle extracted but server entry missing at ${entry}`);
  }
  return dir;
}
