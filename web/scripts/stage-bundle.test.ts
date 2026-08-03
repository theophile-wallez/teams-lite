// The guard the embedded web bundle never had.
//
// The binary's build script shipped `server.ts` and `dist/` and nothing else. When
// server.ts gained `import "./write-token"`, the tarball lost a module the server
// needs, and `teams` crashed on startup from any newly built binary. Nothing failed
// at build time; no test looked. These tests look.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  RUNTIME_ENTRIES,
  WEB_DIR,
  relativeImportGraph,
  runtimePaths,
} from "./stage-bundle";
import { BUILD_INFO_FILE, refuseToServeReason, type BuildInfo } from "../build-info";

/** Is `file` (relative to the web root) inside one of the runtime entries? */
function covered(file: string): boolean {
  return RUNTIME_ENTRIES.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

describe("the production runtime file set", () => {
  it("covers every module the server imports, transitively", () => {
    const reached = relativeImportGraph(join(WEB_DIR, "server.ts"));
    // Sanity: the walker found more than the entry itself, or it proves nothing.
    expect(reached).toContain("write-token.ts");
    expect(reached).toContain("build-info.ts");

    const uncovered = reached.filter((file) => !covered(file));
    expect(
      uncovered,
      `web/server.ts imports ${uncovered.join(", ")}, which RUNTIME_ENTRIES does not ship. ` +
        `Add it there (web/scripts/stage-bundle.ts) so the teams binary and the systemd ` +
        `service both carry it.`,
    ).toEqual([]);
  });

  it("names only entries that exist in the source tree", () => {
    // dist/ is build output, so it may legitimately be absent here; the source files
    // must not be.
    const sources = runtimePaths().filter((path) => !path.includes("/dist/"));
    for (const path of sources) expect(existsSync(path), `missing ${path}`).toBe(true);
  });
});

describe("refusing a bundle built for a test", () => {
  const pinned: BuildInfo = {
    pinnedBackend: "ws://127.0.0.1:19457",
    builtAt: "2026-07-29T09:00:00.000Z",
    commit: null,
  };
  const clean: BuildInfo = { pinnedBackend: null, builtAt: pinned.builtAt, commit: null };

  it("refuses a pinned build and says how to rebuild it", () => {
    const reason = refuseToServeReason(pinned, {});
    expect(reason).toContain("ws://127.0.0.1:19457");
    expect(reason).toContain("bun run build");
  });

  it("serves a normal build", () => {
    expect(refuseToServeReason(clean, {})).toBeNull();
  });

  it("lets the E2E harness serve its own pinned build on purpose", () => {
    expect(refuseToServeReason(pinned, { TEAMS_LITE_ALLOW_PINNED_BUILD: "1" })).toBeNull();
  });

  it("does not judge a build that predates the marker", () => {
    expect(refuseToServeReason(null, {})).toBeNull();
  });

  it("keeps the marker inside dist, where the build writes it", () => {
    expect(BUILD_INFO_FILE.startsWith(".")).toBe(true);
    expect(BUILD_INFO_FILE).not.toContain("/");
  });
});
