import { describe, expect, it } from "vitest";
import {
  ALLOW_PINNED_ENV,
  bundleWasReplaced,
  refuseToServeReason,
  type BuildInfo,
} from "./build-info";

const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  pinnedBackend: null,
  builtAt: "2026-08-06T10:24:22.506Z",
  commit: "4c069e2fa4460000000000000000000000000000",
  ...over,
});

describe("refuseToServeReason", () => {
  it("serves an ordinary build", () => {
    expect(refuseToServeReason(build(), {})).toBeNull();
  });

  it("refuses a build pinned to one backend, and names the way out", () => {
    const info = build({ pinnedBackend: "ws://127.0.0.1:19457" });
    const reason = refuseToServeReason(info, {});
    expect(reason).toContain("ws://127.0.0.1:19457");
    expect(reason).toContain("VITE_TEAMS_WS_URL");
  });

  it("lets the test harness serve its own pinned build on purpose", () => {
    const info = build({ pinnedBackend: "ws://127.0.0.1:19457" });
    expect(refuseToServeReason(info, { [ALLOW_PINNED_ENV]: "1" })).toBeNull();
  });

  it("judges nothing about a bundle that predates the stamp", () => {
    // Refusing an older artifact would break it for no gain: absence is not proof.
    expect(refuseToServeReason(null, {})).toBeNull();
  });
});

describe("bundleWasReplaced", () => {
  it("is quiet while the bundle on disk is the one this process imported", () => {
    expect(bundleWasReplaced(build(), build())).toBe(false);
  });

  it("sees a staged update: another commit at the same path", () => {
    // The 2026-08-06 outage. `teams-lite-service.sh` replaced dist/ under the running
    // server, whose next lazy route import then named a chunk that no longer existed.
    const staged = build({
      builtAt: "2026-08-06T10:29:03.890Z",
      commit: "d00922fa0205cc2e0b0f5e7b3eea9f8d017d5449",
    });
    expect(bundleWasReplaced(build(), staged)).toBe(true);
  });

  it("sees a rebuild of the SAME commit", () => {
    // A rebuild rehashes the chunks, so the graph this process holds is gone either way:
    // the commit alone is not the test.
    const rebuilt = build({ builtAt: "2026-08-06T11:02:00.000Z" });
    expect(bundleWasReplaced(build(), rebuilt)).toBe(true);
  });

  it("claims nothing when a stamp cannot be read", () => {
    // A bundle mid-copy has no stamp for an instant, and a build older than the stamp has
    // none at all. Neither is evidence, and guessing "replaced" would report an update
    // that is not happening in place of the fault the caller really saw.
    expect(bundleWasReplaced(build(), null)).toBe(false);
    expect(bundleWasReplaced(null, build())).toBe(false);
    expect(bundleWasReplaced(null, null)).toBe(false);
  });
});
