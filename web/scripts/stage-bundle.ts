// The exact set of files the production web server needs at run time — in ONE place.
//
// WHY THIS FILE EXISTS. Two things ship that set, and they used to each keep their
// own idea of it:
//   • launcher/build.ts tars it into the `teams` binary (which extracts it to
//     ~/.cache/teams-lite/web and runs server.ts from there);
//   • bin/teams-lite-service.sh stages it for the always-on systemd service.
// The tar list said `server.ts dist` and nothing else, so when server.ts gained
// `import "./write-token"` the embedded bundle lost a module it needs and `teams`
// crashed on startup from any freshly built binary. Nothing failed at build time,
// and no test looked.
//
// So the list lives here, next to a test that walks server.ts's own relative imports
// and fails when one of them is not covered. Add an import, forget the list, and the
// test says so — instead of a phone doing it later.
//
// The runtime needs no node_modules: `ssr.noExternal: true` at build (vite.config.ts)
// inlines every dependency into dist/server, leaving only node: builtins external.
//
// Usage:
//   bun run scripts/stage-bundle.ts <destination>   # copy the set into <destination>

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO_FILE } from "../build-info";

/**
 * The web app's root (this file lives in <web>/scripts).
 *
 * From `import.meta.url` rather than Bun's `import.meta.dir`, because the test for
 * this module runs under Vitest (Node), where `dir` is undefined.
 */
export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything the production server reads at run time, relative to the web app root.
 * Order matters only for readability. Directories are copied whole.
 *
 *   server.ts                the entry (`bun server.ts`)
 *   write-token.ts           hands the page the backend's write token
 *   build-info.ts            lets the server refuse a bundle built for a test
 *   dist/server              the self-contained SSR handler
 *   dist/client              hashed assets, the favicon, and ~30 MB of emoji images
 *   dist/<build info>        what the build was pinned to — the guard reads it, so
 *                            leaving it behind would silently disarm the guard for
 *                            exactly the copies that matter: the staged service
 *                            bundle and the one inside the `teams` binary.
 */
export const RUNTIME_ENTRIES: readonly string[] = [
  "server.ts",
  "write-token.ts",
  "build-info.ts",
  "dist/server",
  "dist/client",
  `dist/${BUILD_INFO_FILE}`,
];

/** Absolute path of every runtime entry, in the same order. */
export function runtimePaths(webDir: string = WEB_DIR): string[] {
  return RUNTIME_ENTRIES.map((entry) => join(webDir, entry));
}

/**
 * Every file reachable from `entry` by RELATIVE import, transitively, as paths
 * relative to `webDir`.
 *
 * Deliberately a small regex walker rather than a bundler: the point is to notice a
 * new `./thing` next to server.ts, and a walker that needs a build step to answer
 * would not run in a unit test. Bare specifiers (`node:fs`) are runtime-provided and
 * ignored; `dist/` is covered wholesale by RUNTIME_ENTRIES, so it is not walked.
 */
export function relativeImportGraph(entry: string, webDir: string = WEB_DIR): string[] {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = relative(webDir, file);
    if (seen.has(key)) continue;
    seen.add(key);

    // `import … from "./x"`, `export … from "./x"`, and `await import("./x")`.
    const text = readFileSync(file, "utf8");
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map(
      (match) => match[1]!,
    );
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(specifier, dirname(file));
      if (!resolved) continue;
      // dist/ is shipped as a whole directory; walking generated code adds nothing.
      if (relative(webDir, resolved).startsWith("dist/")) continue;
      queue.push(resolved);
    }
  }

  return [...seen];
}

/** Resolve one relative specifier to a real file, trying the TS/JS extensions Bun does. */
function resolveSpecifier(specifier: string, fromDir: string): string | null {
  const base = resolve(fromDir, specifier);
  const candidates = [
    base,
    // Bun rewrites a ".js" specifier to its ".ts" source; mirror that.
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && !isDirectory(candidate)) ?? null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copy the runtime set into `destination`, which is created and emptied first.
 * Returns the destination, so a caller can chain.
 */
export function stageBundle(destination: string, webDir: string = WEB_DIR): string {
  const missing = runtimePaths(webDir).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `cannot stage the web bundle, ${missing.length} entr${missing.length === 1 ? "y" : "ies"} ` +
        `missing:\n  ${missing.join("\n  ")}\n` +
        `Build it first: cd ${webDir} && bun run build`,
    );
  }

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) {
    const from = join(webDir, entry);
    const to = join(destination, entry);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  return destination;
}

// CLI: bun run scripts/stage-bundle.ts <destination>
if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) {
    console.error("usage: bun run scripts/stage-bundle.ts <destination>");
    process.exit(2);
  }
  stageBundle(resolve(destination));
  console.log(`staged the web runtime bundle into ${resolve(destination)}`);
}
