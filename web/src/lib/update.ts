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

import type {
  LiveStatus,
  UpdateChangeGroup,
  UpdateChanges,
  UpdateInfo,
  UpdateProgress,
} from "./protocol";

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
  /**
   * What the update brings, for the disclosure the control opens on hover — null when
   * there is nothing to disclose: the backend could not read the comparison, or the
   * update is already taken.
   *
   * It is not part of any sentence above. A changelog is content the reader ASKS for, so
   * it lives behind a hover (a long press on a touch screen) and never in the row: the row
   * is the button, and a list that appeared under it would move the control mid-aim.
   */
  changes: UpdateChanges | null;
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
  changes: null,
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
  const base = { ...HIDDEN, url: info.url, changes: pendingChanges(info) };
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
      // The list is what somebody decides WITH. This decision is made and the app is
      // going down for a moment, so there is nothing left to disclose.
      changes: null,
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
        // Taken. What it brought is in the release notes from here on, not behind a control
        // whose work is over.
        changes: null,
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

/**
 * The changes worth disclosing, or null.
 *
 * A comparison the backend could not read arrives absent, and one that came back empty
 * arrives with no groups — both mean the same thing to a reader, so both are null here
 * rather than an empty panel with a heading over it. The button is unaffected either way:
 * that an update EXISTS is what it offers, and what it brings is the disclosure on top.
 */
function pendingChanges(info: UpdateInfo): UpdateChanges | null {
  const changes = info.changes;
  if (!changes || !changes.groups?.length) return null;
  return changes;
}

/** The panel's own list: the changes a reader can see, and a COUNT of the rest. */
export type ReaderChanges = {
  /** The groups to draw, in the backend's own order. */
  groups: UpdateChangeGroup[];
  /** How many changes were folded into that count. 0 in the ordinary case. */
  internal: number;
};

/**
 * Split what the update brings into what a reader can see and how much work came with it.
 *
 * A refactor alters no behaviour by definition, a test proves what already shipped and a
 * bumped dependency is somebody's Tuesday — so they must not stand between the reader and
 * the features. The release page has room to keep them one press away behind a disclosure
 * (`to_markdown` in src/changelog.rs); this panel is a 22 rem card over a sidebar, and its
 * room is a COUNT.
 *
 * It is not a nicety. Measured on the release a reader photographed: five changes, of which
 * one feature, two fixes and TWO REFACTORS — so two of the five lines in a panel that shows
 * the newest few were work nobody outside the code can see, drawn at the same size and under
 * their own heading as the feature above them.
 *
 * WHICH groups those are is the BACKEND's answer (`group.development`), never a list of
 * titles recognised here: one set, named once, or a heading renamed in Rust quietly stops
 * being folded in the app.
 */
export function readerChanges(changes: UpdateChanges | null): ReaderChanges {
  if (!changes) return { groups: [], internal: 0 };
  const visible = changes.groups.filter((group) => !group.development);
  // Nothing above the fold means nothing to fold — the work IS the update. A panel whose
  // whole content is the sentence "and 4 internal changes" reads as one that failed to
  // load, and it is exactly the release that most needs to say what it was for. The page
  // takes the same exception, for the same reason.
  if (visible.length === 0) return { groups: changes.groups, internal: 0 };
  const internal = changes.groups
    .filter((group) => group.development)
    .reduce((n, group) => n + group.changes.length, 0);
  return { groups: visible, internal };
}

/**
 * The one line the folded work becomes, or nothing.
 *
 * COUNTED rather than dropped, because it is why a release exists on a day nobody shipped a
 * feature — the rule `omitted` already obeys one line up: a list that quietly stops reads as
 * a complete one. It says "internal" rather than naming the four headings, since which kind
 * of work it was is precisely what the reader does not need.
 */
export function internalChangesNote(count: number): string {
  if (count <= 0) return "";
  return `and ${count} internal change${count === 1 ? "" : "s"}`;
}

/**
 * The disclosure's own heading: how much this update is, in one line.
 *
 * A count, never a build: it answers "is this a typo fix or a fortnight of work?", which is
 * the question somebody hovers to ask before spending 130 MB. `omitted` is stated in the
 * same breath, because a list that stops without saying so reads as a complete one.
 *
 * It counts EVERY change the panel carries, the folded work included — that work is below,
 * as `internalChangesNote`'s own line, so a reader can still account for each one. Counting
 * only the listed ones would understate how far behind the build is, which is the one thing
 * this line exists to state.
 */
export function changesSummary(changes: UpdateChanges | null): string {
  if (!changes) return "";
  const total = Math.max(changes.total, countChanges(changes));
  const shown = countChanges(changes);
  const word = total === 1 ? "change" : "changes";
  if (changes.omitted > 0 && shown < total) {
    return `${total} ${word} since your build — the newest ${shown} below`;
  }
  return `${total} ${word} since your build`;
}

/** How many entries the list really carries, across every group. */
export function countChanges(changes: UpdateChanges | null): number {
  if (!changes) return 0;
  return changes.groups.reduce((n, group) => n + group.changes.length, 0);
}

/** The download's cost, stated before the click that spends it — this may be a phone on
 *  a metered connection, which is the whole reason nothing downloads on its own. It is a
 *  hint rather than a line: the user asked for the button alone. */
function sizeHint(size: number | undefined): string {
  const formatted = formatBytes(size ?? 0);
  return formatted ? `Downloads ${formatted}.` : "";
}
