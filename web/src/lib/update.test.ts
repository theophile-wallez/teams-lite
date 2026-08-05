import { describe, expect, it } from "vitest";
import type { UpdateChanges, UpdateInfo, UpdateProgress } from "./protocol";
import {
  changesSummary,
  countChanges,
  downloadPercent,
  formatBytes,
  updateView,
} from "./update";

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

  it("offers the download first, and says what it costs in the control's own title", () => {
    const view = updateView(info, null, "connected");
    expect(view.shape).toBe("button");
    expect(view.action).toBe("download");
    expect(view.label).toBe("Update available");
    expect(view.hint).toBe("Downloads 133 MB.");
    expect(view.detail).toBe("");
    expect(view.busy).toBe(false);
  });

  // A commit sha is a fault code to the person reading it, and there is only one release
  // to take, so no state spells the build — see the head of update.ts.
  it("never states the build it would install", () => {
    for (const phase of ["idle", "downloading", "ready", "installed", "failed"] as const) {
      const view = updateView(info, progress({ phase }), "connected");
      for (const words of [view.label, view.detail, view.hint]) {
        expect(words).not.toContain(info.latest);
      }
    }
    const link = updateView({ ...info, can_install: false }, null, "connected");
    for (const words of [link.label, link.detail, link.hint]) {
      expect(words).not.toContain(info.latest);
    }
  });

  // The row is the button. A sentence that only EXPLAINS the control is its title, so the
  // button never moves while the user is aiming at it; a line of its own is kept for what
  // happened, which is a failure and the state nothing restarted.
  it("keeps a line of its own for what happened, and nothing else", () => {
    const withALine = ["failed", "installed"] as const;
    for (const phase of ["idle", "downloading", "ready", "restarting"] as const) {
      expect(updateView(info, progress({ phase }), "connected").detail).toBe("");
    }
    for (const phase of withALine) {
      expect(updateView(info, progress({ phase }), "connected").detail).not.toBe("");
    }
    expect(updateView({ ...info, can_install: false }, null, "connected").detail).toBe("");
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
    expect(view.hint).toBe("Installs the new build and restarts the app.");
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
    expect(view.label).toBe("Update available");
    expect(view.hint).toContain("where it was installed from");
  });

  it("treats a missing can_install as no", () => {
    const { can_install: _dropped, ...without } = info;
    expect(updateView(without, null, "connected").shape).toBe("link");
  });
});

// ---- what the update brings ---------------------------------------------------------

const changes: UpdateChanges = {
  groups: [
    { title: "New", changes: [{ scope: "calendar", summary: "join a meeting" }] },
    {
      title: "Fixed",
      changes: [
        { scope: "media", summary: "name a file safely" },
        { summary: "report a refused send" },
      ],
    },
  ],
  total: 3,
  omitted: 0,
};

describe("updateView, and the changelog behind the control", () => {
  it("carries the changes while the update is still to be taken", () => {
    for (const phase of ["idle", "downloading", "ready", "failed"] as const) {
      expect(updateView({ ...info, changes }, progress({ phase }), "connected").changes).toEqual(
        changes,
      );
    }
    // And on the install this app cannot replace: the user is about to open a release
    // page, so knowing what is in it beforehand is worth exactly as much.
    expect(
      updateView({ ...info, changes, can_install: false }, null, "connected").changes,
    ).toEqual(changes);
  });

  // The list is what somebody decides WITH, so it goes once the decision is made. Both of
  // these states are past it.
  it("drops the changes once the update is taken", () => {
    for (const phase of ["restarting", "installed"] as const) {
      expect(
        updateView({ ...info, changes }, progress({ phase }), "connected").changes,
      ).toBeNull();
    }
  });

  // A comparison the backend could not read (offline, rate-limited, a force-pushed
  // history) must cost the DISCLOSURE and never the button: that an update exists is the
  // thing the row is for.
  it("still offers the update when nothing could be read about it", () => {
    for (const absent of [undefined, null, { groups: [], total: 0, omitted: 0 }]) {
      const view = updateView({ ...info, changes: absent }, null, "connected");
      expect(view.changes).toBeNull();
      expect(view.shape).toBe("button");
      expect(view.action).toBe("download");
    }
  });

  // The same rule the words obey: no state spells the build. A count answers what somebody
  // hovers to ask — is this a typo or a fortnight? — and a sha answers nothing.
  it("never spells the build in the disclosure either", () => {
    const view = updateView({ ...info, changes }, null, "connected");
    expect(changesSummary(view.changes)).not.toContain(info.latest);
    expect(changesSummary(view.changes)).not.toContain(info.current);
  });
});

describe("changesSummary", () => {
  it("counts the changes, in the plural the count needs", () => {
    expect(changesSummary(changes)).toBe("3 changes since your build");
    expect(
      changesSummary({
        groups: [{ title: "Fixed", changes: [{ summary: "one thing" }] }],
        total: 1,
        omitted: 0,
      }),
    ).toBe("1 change since your build");
  });

  // A list that stops without saying so reads as a complete one — which is the whole
  // reason `omitted` travels.
  it("says how much it is not showing", () => {
    expect(changesSummary({ ...changes, total: 40, omitted: 37 })).toBe(
      "40 changes since your build — the newest 3 below",
    );
  });

  it("says nothing about nothing", () => {
    expect(changesSummary(null)).toBe("");
  });

  it("counts across every group", () => {
    expect(countChanges(changes)).toBe(3);
    expect(countChanges(null)).toBe(0);
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
