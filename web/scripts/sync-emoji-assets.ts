// Copies the Apple emoji images we render into `public/emoji/apple/64/`.
//
// The app shows reactions with the Apple emoji set (see `components/emoji.tsx`),
// and it must do so without reaching for a CDN: teams-lite is local-first, and
// emoji that break when the network does — or that ping jsdelivr on every open
// conversation — are not what this app is. So the images ship from our own
// origin, sourced from the `emoji-datasource-apple` dev dependency at install
// time rather than committed as ~3800 binaries.
//
// `public/emoji/` is therefore generated and git-ignored. This runs on
// `postinstall` and again before `build`/`dev`, and no-ops when the copy already
// matches the installed package version (recorded in a stamp file).
//
// Usage:
//   bun run sync:emoji           # copy when the stamp is stale (the default)
//   bun run sync:emoji --force   # copy unconditionally

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WEB_DIR = join(import.meta.dirname, "..");
const PACKAGE_DIR = join(WEB_DIR, "node_modules/emoji-datasource-apple");
/** The 64px individual images — one per emoji, ~27 MB in total. Individual
 *  files, not a sprite sheet: a chip loads exactly the one emoji it shows. */
const SOURCE_DIR = join(PACKAGE_DIR, "img/apple/64");
const TARGET_DIR = join(WEB_DIR, "public/emoji/apple/64");
const STAMP_FILE = join(WEB_DIR, "public/emoji/.version");

async function installedVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8"));
  return String(manifest.version);
}

async function syncedVersion(): Promise<string | null> {
  try {
    return (await readFile(STAMP_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

async function main() {
  const force = process.argv.includes("--force");

  if (!existsSync(SOURCE_DIR)) {
    throw new Error(
      `${SOURCE_DIR} is missing — install the web dependencies (\`bun install\` in web/) first`,
    );
  }

  const version = await installedVersion();
  if (!force && (await syncedVersion()) === version && existsSync(TARGET_DIR)) {
    console.log(`emoji images already synced (emoji-datasource-apple ${version})`);
    return;
  }

  // Replace wholesale rather than merge, so images dropped by a package upgrade
  // don't linger and get served forever.
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await cp(SOURCE_DIR, TARGET_DIR, { recursive: true });
  await writeFile(STAMP_FILE, `${version}\n`);
  console.log(`synced emoji images from emoji-datasource-apple ${version} -> public/emoji/apple/64`);
}

await main();
