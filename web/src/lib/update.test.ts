import { describe, expect, it } from "vitest";
import type { UpdateInfo, UpdateProgress } from "./protocol";
import { downloadPercent, formatBytes, updateView } from "./update";

const info: UpdateInfo = {
  current: "abc1234",
  latest: "def5678",
  url: "https://github.com/theophile-wallez/teams-lite/releases/tag/latest",
  size: 133 * 1024 * 1024,
  can_install: true,
};

const progress = (over: Partial<UpdateProgress>): UpdateProgress => ({
  phase: "idle",
  received: 0,
  total: info.size ?? 0,
  error: "",
  ...over,
});

describe("updateView", () => {
  it("shows nothing until a newer build is known", () => {
    expect(updateView(null, null, "connected").shape).toBe("hidden");
  });

  it("offers the download first, and says what it costs", () => {
    const view = updateView(info, null, "connected");
    expect(view.shape).toBe("button");
    expect(view.action).toBe("download");
    expect(view.label).toBe("Update to def5678");
    expect(view.detail).toBe("Downloads 133 MB.");
    expect(view.busy).toBe(false);
  });

  it("draws the progress while downloading, and lets nothing be clicked", () => {
    const view = updateView(info, progress({ phase: "downloading", received: (info.size ?? 0) / 4 }), "connected");
    expect(view.label).toBe("Downloading… 25%");
    expect(view.percent).toBe(25);
    expect(view.busy).toBe(true);
    expect(view.action).toBe("none");
  });

  it("asks for the second click once the build is downloaded", () => {
    const view = updateView(info, progress({ phase: "ready", received: info.size ?? 0 }), "connected");
    expect(view.label).toBe("Restart to update");
    expect(view.detail).toBe("Installs def5678 and restarts the app.");
    expect(view.action).toBe("apply");
    expect(view.busy).toBe(false);
  });

  // THE SEAMLESS PART. Applying takes the backend and the web server down together, so
  // the socket is gone for a few seconds. If this state hid itself with the rest, the
  // user's click would be followed by the control vanishing.
  it("keeps saying it is restarting after the socket goes away", () => {
    for (const live of ["connected", "connecting", "disconnected"] as const) {
      const view = updateView(info, progress({ phase: "restarting" }), live);
      expect(view.label).toBe("Restarting…");
      expect(view.busy).toBe(true);
    }
  });

  it("hides every other state while the socket is down, rather than claiming one", () => {
    for (const phase of ["idle", "downloading", "ready", "failed"] as const) {
      expect(updateView(info, progress({ phase }), "connecting").shape).toBe("hidden");
    }
  });

  it("offers a retry after a failure, and says what went wrong", () => {
    const view = updateView(info, progress({ phase: "failed", error: "connection reset" }), "connected");
    expect(view.action).toBe("retry");
    expect(view.detail).toBe("connection reset");
  });

  it("states the one thing left to do when nothing restarted the app", () => {
    const view = updateView(info, progress({ phase: "installed" }), "connected");
    expect(view.shape).toBe("note");
    expect(view.action).toBe("none");
    expect(view.detail).toContain("next time you start it");
  });

  // An install this app cannot replace (the staged always-on service, in practice) keeps
  // the link it had before there was a button — never a dead button, and never a click
  // that would report success while the service kept running what it had.
  it("keeps a link for an install it cannot replace", () => {
    const view = updateView({ ...info, can_install: false }, null, "connected");
    expect(view.shape).toBe("link");
    expect(view.action).toBe("none");
    expect(view.url).toBe(info.url);
    expect(view.label).toBe("Update available (def5678)");
  });

  it("treats a missing can_install as no", () => {
    const { can_install: _dropped, ...without } = info;
    expect(updateView(without, null, "connected").shape).toBe("link");
  });
});

describe("downloadPercent", () => {
  it("is zero without a total, so a bar never grows on a guess", () => {
    expect(downloadPercent(null)).toBe(0);
    expect(downloadPercent(progress({ total: 0, received: 500 }))).toBe(0);
  });

  it("clamps to its own end", () => {
    expect(downloadPercent(progress({ total: 100, received: 250 }))).toBe(100);
    expect(downloadPercent(progress({ total: 100, received: -5 }))).toBe(0);
  });
});

describe("formatBytes", () => {
  it("speaks in whole megabytes", () => {
    expect(formatBytes(133 * 1024 * 1024)).toBe("133 MB");
    expect(formatBytes(1024 * 1024 + 1)).toBe("1 MB");
  });

  it("falls back to kilobytes, and says nothing about nothing", () => {
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});
