// What a built bundle knows about itself — and the one check that keeps a TEST
// build from ever being served to a real user.
//
// THE TRAP THIS CLOSES. `VITE_TEAMS_WS_URL` is consumed by the BUILD: whatever it
// names is compiled into the client bundle as the backend the page dials (see
// `defaultWsUrl` in src/lib/ws-client.ts). The E2E suite sets it to its mock and
// runs a full `bun run build` (web/playwright.config.ts), so **every E2E run leaves
// web/dist pointing at a mock port**. That output is indistinguishable from a
// production build by looking at the directory, and it has already happened: the
// dist in the main checkout carried `ws://127.0.0.1:8456` for days.
//
// Served to a phone the damage is quiet rather than loud — a loopback target plus a
// non-loopback page host makes the page fall back to the relay, so it works by
// accident — and on the desktop it simply cannot reach a backend at all. Either way
// the operator has no way to tell. So the build records what it was pinned to, and
// the production server refuses to serve a pinned bundle unless the harness that
// made it says so.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the build drops its self-description, inside `dist/`. */
export const BUILD_INFO_FILE = ".teams-lite-build.json";

/**
 * Env var the TEST harness sets to serve its own pinned build on purpose
 * (web/playwright.config.ts). Nothing else should ever set it: a pinned bundle
 * reaching a real user is the failure this file exists to prevent.
 */
export const ALLOW_PINNED_ENV = "TEAMS_LITE_ALLOW_PINNED_BUILD";

export type BuildInfo = {
  /**
   * The backend URL baked into the client bundle by `VITE_TEAMS_WS_URL`, or null
   * for a normal build (which lets the page decide at runtime: the backend on this
   * machine, or the relay when the page came from somewhere else).
   */
  pinnedBackend: string | null;
  /** ISO timestamp of the build, so an operator can tell what is being served. */
  builtAt: string;
  /** `TEAMS_BUILD_REV` when the build knew it (CI, or the service installer). */
  commit: string | null;
};

/** Read `dist/.teams-lite-build.json`, or null when a build predates it. */
export function readBuildInfo(distDir: string): BuildInfo | null {
  const path = join(distDir, BUILD_INFO_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildInfo>;
    return {
      pinnedBackend: parsed.pinnedBackend ?? null,
      builtAt: parsed.builtAt ?? "unknown",
      commit: parsed.commit ?? null,
    };
  } catch {
    // Unreadable or malformed: treat it as absent rather than as proof of anything.
    return null;
  }
}

/**
 * Whether the bundle on disk is no longer the one this process imported.
 *
 * THE FAILURE THIS NAMES. The SSR handler is imported once at boot, but it imports its
 * ROUTE chunks off disk as the routes are asked for — `dist/server/assets/*.js`, hashed
 * per build. `bin/teams-lite-service.sh` replaces that whole directory in place, so a
 * staged update under a running web server leaves it holding a module graph whose files
 * are gone: the next lazy import throws, and what comes back is not a Response Bun will
 * serve (see `renderWithSsr` in server.ts). The process stays up and the app is dead.
 *
 * The stamp is what tells that apart from an ordinary SSR fault, and the difference is
 * the whole answer: a replaced bundle is being updated and will be right in a moment, so
 * the reader is asked to reload; a fault at the same build is a fault, and saying "we are
 * updating" about it would send them reloading for ever.
 *
 * A stamp that cannot be read now proves nothing — a bundle mid-copy has no stamp for an
 * instant — so it reads as "not replaced" and the caller reports the fault it really saw.
 * Pure, so the decision is unit-tested without a build or a server.
 */
export function bundleWasReplaced(
  atBoot: BuildInfo | null,
  onDisk: BuildInfo | null,
): boolean {
  if (!atBoot || !onDisk) return false;
  return atBoot.builtAt !== onDisk.builtAt || atBoot.commit !== onDisk.commit;
}

/**
 * The reason this bundle must not be served, or null when it may be.
 *
 * A missing file is NOT an error: a bundle built before this check existed cannot
 * be judged, and refusing it would break every older artifact for no gain. What is
 * refused is a bundle that says, in its own words, that it was pinned to one
 * backend — unless {@link ALLOW_PINNED_ENV} is set, which only the E2E harness does.
 *
 * Pure, so the decision is unit-tested without a build or a server.
 */
export function refuseToServeReason(
  info: BuildInfo | null,
  env: Record<string, string | undefined>,
): string | null {
  if (!info?.pinnedBackend) return null;
  if (env[ALLOW_PINNED_ENV] === "1") return null;
  return (
    `this build is pinned to ${info.pinnedBackend} (VITE_TEAMS_WS_URL was set when it ` +
    `was built${info.builtAt === "unknown" ? "" : ` at ${info.builtAt}`}), so the page ` +
    `would dial that backend instead of this machine's.\n` +
    `  A test run leaves such a build behind: web/playwright.config.ts builds with its ` +
    `mock's URL.\n` +
    `  Rebuild for production, with the variable unset:\n` +
    `    cd web && rm -rf dist && env -u VITE_TEAMS_WS_URL bun run build`
  );
}
