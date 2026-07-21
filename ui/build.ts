// Build the standalone `teams` binary (opencode-style single command).
//
// This produces ONE self-contained executable that embeds:
//   • the Bun runtime + the compiled UI (OpenTUI + Solid),
//   • OpenTUI's native Zig library (libopentui.so, embedded by Bun automatically
//     via its `type: "file"` import), and
//   • the Rust backend binary (target/release/server), embedded here and
//     extracted to ~/.cache/teams-lite/server on first launch.
//
// Usage:
//   cargo build --release --bin server   # produce ../target/release/server
//   cd ui && bun run build.ts             # produce ui/dist/teams
//
// Notes / gotchas learned the hard way:
//   • The Solid JSX transform is applied at BUILD time via @opentui/solid's bun
//     plugin, so the compiled binary needs no runtime `preload`. We temporarily
//     move bunfig.toml aside during the compile because Bun BAKES bunfig's
//     `preload = ["@opentui/solid/preload"]` into the standalone, which then
//     crashes at boot ("preload not found") since node_modules isn't shipped.
//   • `bun build --compile` writes a ZERO-FILLED (corrupt) binary when the
//     outfile lives on a different filesystem than the build (e.g. /tmp tmpfs
//     vs the on-disk repo). We therefore always emit inside the repo (ui/dist).
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const uiDir = import.meta.dir;
const repoRoot = join(uiDir, "..");

// 1. Locate the release backend binary.
const serverBin = join(repoRoot, "target", "release", "server");
if (!existsSync(serverBin)) {
  console.error(
    "error: backend not built. Run `cargo build --release --bin server` first.",
  );
  process.exit(1);
}

// 2. Stage it as a local, non-escaping asset for the embed import
//    (ui/src/embedded-server.ts imports "../server.embed").
const embedPath = join(uiDir, "server.embed");
copyFileSync(serverBin, embedPath);

// 2b. Build the web UI and stage it as an embedded tarball so `teams --web`
//     works from the single binary (see ui/src/embedded-web.ts / web-embed.ts).
//     web/server.ts resolves its dist/ relative to itself, so the archive keeps
//     that layout: server.ts + dist/ at the archive root -> extracted to
//     ~/.cache/teams-lite/web on first launch. Set TEAMS_SKIP_WEB=1 to skip
//     (produces a binary whose `teams --web` reports the UI is unavailable).
const webDir = join(repoRoot, "web");
const webTar = join(uiDir, "web.tar.gz");
const skipWeb = process.env.TEAMS_SKIP_WEB === "1";
if (!skipWeb) {
  if (!existsSync(join(webDir, "node_modules"))) {
    console.error(
      "error: web deps missing. Run `cd web && bun install` first (or set TEAMS_SKIP_WEB=1).",
    );
    process.exit(1);
  }
  console.log("building web UI…");
  const webBuild = Bun.spawnSync(["bun", "run", "build"], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!webBuild.success) {
    console.error("error: web build failed.");
    process.exit(1);
  }
  const tar = Bun.spawnSync(["tar", "-czf", webTar, "-C", webDir, "server.ts", "dist"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!tar.success) {
    console.error("error: could not archive the web bundle.");
    process.exit(1);
  }
} else {
  // The embed import needs the file to exist even when empty, or the compile
  // fails to resolve "../web.tar.gz". Write a tiny placeholder archive.
  Bun.spawnSync(["tar", "-czf", webTar, "-C", uiDir, "--files-from", "/dev/null"], {
    stderr: "inherit",
  });
}

// 3. Compile the single binary. Emit inside the repo (same filesystem) to avoid
//    the cross-filesystem zero-fill bug, then the caller/CI moves it if needed.
const outDir = join(uiDir, "dist");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "teams");

// Optional cross-compile target, e.g. TEAMS_BUILD_TARGET=bun-linux-arm64.
// Defaults to the current platform when unset.
const target = process.env.TEAMS_BUILD_TARGET as
  | `bun-${string}`
  | undefined;

// Move bunfig.toml aside so its runtime `preload` is not baked into the
// standalone (see header note). Restored in the finally block no matter what.
const bunfig = join(uiDir, "bunfig.toml");
const bunfigStashed = join(uiDir, "bunfig.toml.building");
const hadBunfig = existsSync(bunfig);
if (hadBunfig) renameSync(bunfig, bunfigStashed);

try {
  const result = await Bun.build({
    entrypoints: [join(uiDir, "src", "index.tsx")],
    target: "bun",
    plugins: [solidPlugin],
    compile: target ? { target, outfile } : { outfile },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
} finally {
  if (hadBunfig) renameSync(bunfigStashed, bunfig);
  rmSync(embedPath, { force: true });
  rmSync(webTar, { force: true });
}

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
