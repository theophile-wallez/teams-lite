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
// takes the place of the words that were pressed, so the one thing that moves between the
// two clicks is the fill.
//
// The ROW IS THE BUTTON. What a click costs is the button's own title (`view.hint`), never
// a line under it: this row sits at the foot of a sidebar whose job is chat rows, and a
// sentence that comes and goes moves the button the user is aiming at. A line is kept for
// what HAPPENED — a failure's reason, and the one thing left to do when nothing restarted
// the app — because a report nobody can hover is a report on a phone that does not exist.
//
// Blue, and deliberately: `variant="default"` is the app's own accent, the same one the
// primary action of every dialog wears. An update is the one thing here the user gains
// something by pressing, so it reads as an invitation rather than as a warning — the
// destructive red belongs to the broker banner, which reports something broken.

import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { ThinkingOrb } from "thinking-orbs";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";
import { updateView, type UpdateAction } from "~/lib/update";

export function UpdateButton() {
  const info = useAppState((s) => s.update);
  const progress = useAppState((s) => s.updateProgress);
  const live = useAppState((s) => s.live);
  const resolvedTheme = useAppState((s) => s.resolvedTheme);
  const controller = useController();

  const view = updateView(info, progress, live);
  if (view.shape === "hidden") return null;

  // INVERTED, and it has to be: the orb sits on `bg-primary`, whose own foreground flips
  // the other way from the page (white ink on the light theme's indigo, near-black ink on
  // the dark theme's brighter one — see --primary-foreground in styles/theme.css). The
  // orb's own `auto` reads the app's `data-theme` and would therefore be wrong in both.
  const orbTheme = resolvedTheme === "dark" ? "light" : "dark";

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
          title={view.hint}
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
          title={view.hint}
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
            {view.busy ? (
              <UpdateOrb label={view.label} theme={orbTheme} />
            ) : (
              <HugeiconsIcon
                icon={view.action === "apply" ? Refresh01Icon : Download04Icon}
                className="size-4"
                strokeWidth={1.8}
              />
            )}
            {view.label}
          </span>
        </Button>
      )}

      {/* The link carries its hint as a title, because a second line under a one-line
          notice is more room than it deserves. A NOTE is the whole statement, so its
          detail is the sentence that says what is left to do; a BUTTON draws one only
          when something happened — in practice, a failure and its reason. */}
      {view.detail && (
        <p data-testid="update-detail" className="text-[11px] leading-snug text-text-faint">
          {view.detail}
        </p>
      )}
    </div>
  );
}

/**
 * The work, drawn as an orb rather than as a turning glyph.
 *
 * `thinking-orbs` (MIT, no dependencies, a plain 2D canvas — no WebGL and no filters) is
 * a loading INDICATOR, not an icon set, so § Hugeicons is untouched: every glyph in this
 * app still comes from one library, and this is the one thing in it that is not a glyph.
 * `solving` is the state whose bands scramble and click back, which is what a transfer of
 * a fixed size looks like; the 20 px preset is the package's own inline-text design, not a
 * scaled-down 64.
 *
 * Two things are given to it rather than detected. The theme, because the ink has to
 * contrast with the BUTTON and not with the page — see the inversion at the call site. And
 * the label, because the orb reports the button's phase and the button already words it:
 * two spellings of one state is what a screen reader would read out twice.
 *
 * The package pauses itself when the tab is hidden or the row scrolls out of view, and it
 * renders one still frame under `prefers-reduced-motion` — which is why nothing here has
 * to unmount it.
 */
function UpdateOrb({ label, theme }: { label: string; theme: "light" | "dark" }) {
  return (
    <ThinkingOrb
      state="solving"
      size={20}
      theme={theme}
      aria-label={label}
      data-testid="update-orb"
      className="shrink-0"
    />
  );
}
