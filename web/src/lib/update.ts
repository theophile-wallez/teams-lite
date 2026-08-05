// What the update control shows, as one pure function.
//
// The update is two clicks — download, then restart onto it (see src/update.rs for the
// backend half) — and the control that offers them has six states plus two ways of not
// being a button at all. Deciding which is a matter of three inputs and no DOM, so it
// lives here and `update-button.tsx` only draws the answer. That is what lets every rule
// below be pinned by a unit test rather than by a screenshot.
//
// The three inputs, and why each is needed:
//   • `info`  — that a newer build exists, and whether this install can replace itself.
//   • `phase` — how far the user has taken it, which the backend replays on every
//     connection so a phone joining mid-download draws the bar it is already in.
//   • `live`  — the socket. It matters for one state only, and it is the interesting one:
//     a restart takes the backend AND the web server down, so "Restarting…" has to
//     survive being disconnected or the app would go blank at the exact moment it is
//     doing what the user asked.
//
// No state names the build. `info.latest` is the commit the release was compiled from, so
// it reads as a fault code in the middle of a plain sentence — and a sha is not something
// the user can act on: there is one release, `latest`, and pressing the button takes it.
// The control says an update EXISTS, and nothing else. The field stays in the protocol
// because the BACKEND compares it with its own build to decide there is one.
//
// The row is the BUTTON and nothing else, which is what splits `hint` from `detail`. What a
// click costs or does explains a control the label already names, so it is that control's
// own title; a line of its own is kept for what HAPPENED — a failure's reason, and the one
// thing left to do when nothing restarted the app. So the button never moves between the
// two clicks, and the sidebar keeps its rows for the chats.

import type { LiveStatus, UpdateInfo, UpdateProgress } from "./protocol";

/** What a click does, or that there is nothing to click. */
export type UpdateAction = "download" | "apply" | "retry" | "none";

/** How the control is drawn. */
export type UpdateShape =
  /** Nothing to say: no newer build, or nothing known about one. */
  | "hidden"
  /** A button the user can press. */
  | "button"
  /** A link to the release, for an install this app cannot replace itself. */
  | "link"
  /** A statement, with nothing to press. */
  | "note";

export type UpdateView = {
  shape: UpdateShape;
  /** The words on the control. */
  label: string;
  /**
   * A line of its own under the control, for what HAPPENED: a failure's reason, and the
   * one thing left to do once nothing restarted the app. Empty in every ordinary state,
   * so the row is the button and nothing else.
   */
  detail: string;
  /**
   * What a click costs or does, carried by the control's own title rather than by a line.
   * The sidebar is 240 px of chat rows and this row grows upward from the status line, so
   * a sentence that comes and goes moves the button — and it explains a control the label
   * already names, which is what a title is for.
   */
  hint: string;
  action: UpdateAction;
  /** 0–100 while downloading; 0 otherwise. */
  percent: number;
  /** The app is working on it — the control is inert and says so. */
  busy: boolean;
  /** The release page, for the link shape (and for a failure's way out). */
  url: string;
};

const HIDDEN: UpdateView = {
  shape: "hidden",
  label: "",
  detail: "",
  hint: "",
  action: "none",
  percent: 0,
  busy: false,
  url: "",
};

/** A download's size in the words a person uses. Whole megabytes: the asset is ~130 MB,
 *  and a decimal on a progress line is noise nobody reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(mb)} MB`;
}

/** How far the download is, as a whole percent, clamped so a wrong total cannot draw a
 *  bar past its own end. */
export function downloadPercent(progress: UpdateProgress | null): number {
  if (!progress || progress.total <= 0) return 0;
  const percent = Math.round((progress.received / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

/**
 * Decide what the update control shows.
 *
 * `info` null means no newer build is known — including "the check never ran", which is
 * the state of every build made from source.
 */
export function updateView(
  info: UpdateInfo | null,
  progress: UpdateProgress | null,
  live: LiveStatus,
): UpdateView {
  if (!info) return HIDDEN;
  const base = { ...HIDDEN, url: info.url };
  const phase = progress?.phase ?? "idle";

  // A restart is the one state that outlives the socket, and it must: this app is being
  // replaced, so the backend and the web server both go away for a few seconds. Showing
  // it while disconnected is how the user sees their click doing something instead of an
  // app that went quiet.
  if (phase === "restarting") {
    return {
      ...base,
      shape: "button",
      label: "Restarting…",
      hint: "It comes back on the new build.",
      busy: true,
    };
  }

  // Anything else is a statement about the backend, so it needs a backend. A stale
  // "Update available" over a dead socket is a claim we cannot make.
  if (live !== "connected") return HIDDEN;

  // An install this app cannot replace keeps exactly what it had before there was a
  // button: a link to the release. Never a disabled button — the user is not blocked,
  // their install is simply updated somewhere else.
  if (!info.can_install) {
    return {
      ...base,
      shape: "link",
      label: "Update available",
      hint: "This build is updated where it was installed from, not from here.",
    };
  }

  switch (phase) {
    case "downloading": {
      const percent = downloadPercent(progress);
      return {
        ...base,
        shape: "button",
        label: `Downloading… ${percent}%`,
        percent,
        busy: true,
      };
    }
    case "ready":
      return {
        ...base,
        shape: "button",
        label: "Restart to update",
        hint: "Installs the new build and restarts the app.",
        action: "apply",
        percent: 100,
      };
    case "installed":
      return {
        ...base,
        shape: "note",
        label: "Update installed",
        detail: "Nothing restarted the app — it runs the new build next time you start it.",
      };
    case "failed":
      return {
        ...base,
        shape: "button",
        label: "Update failed — try again",
        detail: progress?.error || "The download did not finish.",
        action: "retry",
      };
    default:
      return {
        ...base,
        shape: "button",
        label: "Update available",
        hint: sizeHint(info.size),
        action: "download",
      };
  }
}

/** The download's cost, stated before the click that spends it — this may be a phone on
 *  a metered connection, which is the whole reason nothing downloads on its own. It is a
 *  hint rather than a line: the user asked for the button alone. */
function sizeHint(size: number | undefined): string {
  const formatted = formatBytes(size ?? 0);
  return formatted ? `Downloads ${formatted}.` : "";
}
