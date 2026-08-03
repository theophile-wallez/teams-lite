// Build the standalone `teams` binary (opencode-style single command).
//
// This produces ONE self-contained executable that embeds:
//   • the Bun runtime + the compiled launcher (cli/src),
//   • the web app (built SSR bundle + assets, as a tarball), and
//   • the Rust backend binary (target/release/server), embedded here and
//     extracted to ~/.cache/teams-lite/server on first launch.
//
// Usage:
//   cargo build --release --bin server   # produce ../target/release/server
//   cd cli && bun run build               # produce cli/dist/teams
//
// One gotcha learned the hard way: `bun build --compile` writes a ZERO-FILLED
// (corrupt) binary when the outfile lives on a different filesystem than the build
// (e.g. /tmp tmpfs vs the on-disk repo). We therefore always emit inside the repo
// (cli/dist).
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const cliDir = import.meta.dir;
const repoRoot = join(cliDir, "..");

// 1. Locate the release backend binary.
const backendBin = join(repoRoot, "target", "release", "server");
if (!existsSync(backendBin)) {
  console.error(
    "error: backend not built. Run `cargo build --release --bin server` first.",
  );
  process.exit(1);
}

// 2. Stage it as a local, non-escaping asset for the embed import
//    (cli/src/embedded-backend.ts imports "../server.embed").
const embedPath = join(cliDir, "server.embed");
copyFileSync(backendBin, embedPath);

// 3. Build the web app and stage it as an embedded tarball (see
//    cli/src/embedded-web.ts / web-bundle.ts). web/server.ts resolves its dist/
//    relative to itself, so the archive keeps that layout: the runtime files +
//    dist/ at the archive root -> extracted to ~/.cache/teams-lite/web on first
//    launch.
//
//    WHAT goes in the archive is not decided here: RUNTIME_ENTRIES in
//    web/scripts/stage-bundle.ts owns that list, and a test there fails when a new
//    relative import escapes it. This used to be a hand-written `server.ts dist`,
//    and the day server.ts imported ./write-token the archive silently lost a
//    module — every launch from a fresh binary then died on startup.
const webDir = join(repoRoot, "web");
const webTar = join(cliDir, "web.tar.gz");
if (!existsSync(join(webDir, "node_modules"))) {
  console.error("error: web deps missing. Run `cd web && bun install` first.");
  process.exit(1);
}
console.log("building the web app…");
const webBuild = Bun.spawnSync(["bun", "run", "build"], {
  cwd: webDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (!webBuild.success) {
  console.error("error: web build failed.");
  process.exit(1);
}
const { RUNTIME_ENTRIES } = await import("../web/scripts/stage-bundle");
const missing = RUNTIME_ENTRIES.filter((entry) => !existsSync(join(webDir, entry)));
if (missing.length > 0) {
  console.error(`error: the web build produced no ${missing.join(", ")}.`);
  process.exit(1);
}
const tar = Bun.spawnSync(["tar", "-czf", webTar, "-C", webDir, ...RUNTIME_ENTRIES], {
  stdout: "inherit",
  stderr: "inherit",
});
if (!tar.success) {
  console.error("error: could not archive the web bundle.");
  process.exit(1);
}

// 4. Compile the single binary. Emit inside the repo (same filesystem) to avoid
//    the cross-filesystem zero-fill bug, then the caller/CI moves it if needed.
const outDir = join(cliDir, "dist");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "teams");

// Optional cross-compile target, e.g. TEAMS_BUILD_TARGET=bun-linux-arm64.
// Defaults to the current platform when unset. Bun validates the value itself and
// fails the build on an unknown one, so the cast states the shape without claiming
// the string was checked here.
const target = process.env.TEAMS_BUILD_TARGET as Bun.Build.CompileTarget | undefined;

try {
  const result = await Bun.build({
    entrypoints: [join(cliDir, "src", "index.ts")],
    target: "bun",
    compile: target ? { target, outfile } : { outfile },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
} finally {
  rmSync(embedPath, { force: true });
  rmSync(webTar, { force: true });
}

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
