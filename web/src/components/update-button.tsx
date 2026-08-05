// The update, offered as two clicks in the sidebar: download it, then restart onto it.
//
// It used to be an eleven-pixel link to the GitHub release, which asked the user to go
// and reinstall the app by hand — and which sat in the status bar, where it REPLACED the
// connection line and could hide a real error (see broker-banner.tsx for the outage that
// exposed). So it moved out into its own row above the status bar, and became a button.
//
// What it shows is `updateView` (lib/update.ts) and nothing else: six phases and two
// non-button shapes, decided from three inputs by a pure function that the unit tests own.
// This file draws that answer, and holds the one thing a screenshot cannot capture — that
// the progress lives INSIDE the button, as a fill behind its own label, so the download
// the user asked for is visible without a second control appearing beside it. The percent
// takes the place of the words that were pressed, and the row keeps its height while it
// does, so the one thing that moves between the two clicks is the fill.
//
// Blue, and deliberately: `variant="default"` is the app's own accent, the same one the
// primary action of every dialog wears. An update is the one thing here the user gains
// something by pressing, so it reads as an invitation rather than as a warning — the
// destructive red belongs to the broker banner, which reports something broken.

import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, Loading02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";
import { updateView, type UpdateAction } from "~/lib/update";

export function UpdateButton() {
  const info = useAppState((s) => s.update);
  const progress = useAppState((s) => s.updateProgress);
  const live = useAppState((s) => s.live);
  const controller = useController();

  const view = updateView(info, progress, live);
  if (view.shape === "hidden") return null;

  const onClick = (action: UpdateAction) => {
    if (action === "download" || action === "retry") void controller.downloadUpdate();
    if (action === "apply") void controller.applyUpdate();
  };

  return (
    <div
      data-testid="update-control"
      data-shape={view.shape}
      data-phase={progress?.phase ?? "idle"}
      // `status`/polite for the same reason the broker banner is: this sits on screen for
      // the length of a download, and an assertive region would interrupt a screen reader
      // on every percent.
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex shrink-0 flex-col gap-1"
    >
      {view.shape === "link" ? (
        <a
          data-testid="update-link"
          href={view.url}
          target="_blank"
          rel="noreferrer"
          title={view.detail}
          className="truncate text-[11px] text-warning underline-offset-2 hover:underline"
        >
          ↑ {view.label}
        </a>
      ) : view.shape === "note" ? (
        <p data-testid="update-note" className="text-[11px] leading-snug text-text-dim">
          {view.label}
        </p>
      ) : (
        <Button
          size="sm"
          data-testid="update-button"
          data-percent={view.percent}
          onClick={() => onClick(view.action)}
          disabled={view.busy}
          // `relative` + `overflow-hidden` are what let the progress be a fill rather
          // than a bar of its own. `disabled:opacity-50` from the variant would grey the
          // download out mid-transfer, so a busy button keeps full contrast: it is
          // working, not unavailable.
          className="relative w-full overflow-hidden disabled:opacity-100"
        >
          {view.busy && view.percent > 0 && (
            <span
              data-testid="update-progress-fill"
              aria-hidden
              // Behind the label, and lighter than the button rather than darker: the
              // filled part is the part that is DONE. `transition-[width]` keeps the
              // percent steps from reading as a stutter — the frames arrive once per
              // percent, which is not a smooth cadence on a fast connection.
              className="absolute inset-y-0 left-0 bg-primary-foreground/25 transition-[width] duration-200 ease-out"
              style={{ width: `${view.percent}%` }}
            />
          )}
          <span className="relative flex items-center gap-2">
            <HugeiconsIcon
              icon={
                view.busy
                  ? Loading02Icon
                  : view.action === "apply"
                    ? Refresh01Icon
                    : Download04Icon
              }
              className={"size-4" + (view.busy ? " animate-spin" : "")}
              strokeWidth={1.8}
            />
            {view.label}
          </span>
        </Button>
      )}

      {/* The link carries its own detail as a title, because a second line under a
          one-line notice is more room than it deserves.

          A BUTTON keeps this line even when there is nothing to say in it, and that empty
          line is the point: the control is anchored above the status bar and grows upward,
          so a line that came and went would move the button under the pointer that just
          pressed it. The download is the case — its progress replaces the button's own
          label, and states its own cost, so there is no second line to draw. */}
      {view.shape === "button" ? (
        <p
          data-testid="update-detail"
          className="min-h-[15px] text-[11px] leading-snug text-text-faint"
        >
          {view.detail}
        </p>
      ) : (
        view.shape === "note" &&
        view.detail && (
          <p data-testid="update-detail" className="text-[11px] leading-snug text-text-faint">
            {view.detail}
          </p>
        )
      )}
    </div>
  );
}
