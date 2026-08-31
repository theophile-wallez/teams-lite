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
//
// WHAT THE UPDATE BRINGS IS A DISCLOSURE ON THE CONTROL ITSELF: hover it and the commits
// between this build and the release open in a panel beside it (a long press on a touch
// screen, which is this app's own pointer convention — see use-long-press.ts and the chat
// row's "…"). Three things follow from the row being the button, and each is pinned by
// web/e2e/update.spec.ts:
//
//   • It is a POPOVER, portaled and anchored — never a section that grows in the row. The
//     row sits at the foot of a sidebar of chat rows, and a list unfolding under the button
//     would move the control the user is aiming at, which is the same rule that makes the
//     download's cost a title rather than a line.
//   • It is BOUNDED and scrolls itself. A build a week behind is 130-odd commits, and a
//     panel as tall as the window would cover the conversation.
//   • The words in it are the AUTHORS' — the commit subjects, grouped by the backend
//     (src/changelog.rs, the same module that writes every release body on GitHub). This
//     file states no heading of its own and re-derives no grouping.
//   • It lists what the reader can SEE and counts the rest. A refactor, a test and a bumped
//     dependency each got a heading and a line of their own here, at the size of the feature
//     above them: measured on the release a reader photographed, two of five lines were work
//     nobody outside the code can see. The split is `readerChanges` (lib/update.ts) off the
//     backend's own flag — the release page has room to keep that work one press away, and
//     this card's room is a count.

import { useState } from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { ThinkingOrb } from "thinking-orbs";
import { Button } from "./ui/button";
import { useLongPress } from "./use-long-press";
import { useAppState, useController } from "./controller-context";
import {
  changesSummary,
  internalChangesNote,
  readerChanges,
  updateView,
  type UpdateAction,
} from "~/lib/update";
import type { UpdateChanges } from "~/lib/protocol";

/** Long enough that crossing the button on the way to a chat does not open it, short
 *  enough to feel like an answer. The person card's own pair, so one hover means one
 *  thing across the app (see person-card.tsx). */
const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 160;

export function UpdateButton() {
  const info = useAppState((s) => s.update);
  const progress = useAppState((s) => s.updateProgress);
  const live = useAppState((s) => s.live);
  const resolvedTheme = useAppState((s) => s.resolvedTheme);
  const controller = useController();

  // Controlled, because TWO gestures open the disclosure: the hover card's own (a pointer
  // resting on the trigger, and a Tab to it) and a long press, which is the only one a
  // touch screen has — Radix's hover card ignores touch entirely, by design. The click
  // stays what it always was: the update itself.
  const [changesOpen, setChangesOpen] = useState(false);

  const view = updateView(info, progress, live);
  const changes = view.changes;
  // Both hooks run before the early return below, unconditionally: this component renders
  // nothing at all most of the time, and a hook behind that return would change order the
  // moment an update appeared.
  const longPress = useLongPress({
    enabled: Boolean(changes),
    onLongPress: () => setChangesOpen(true),
  });
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
        <HoverCardPrimitive.Root
          open={changesOpen && Boolean(changes)}
          onOpenChange={setChangesOpen}
          openDelay={OPEN_DELAY_MS}
          closeDelay={CLOSE_DELAY_MS}
        >
          <HoverCardPrimitive.Trigger asChild>
            <Button
              size="sm"
              data-testid="update-button"
              data-percent={view.percent}
              data-changes={changes ? "yes" : "no"}
              title={view.hint}
              onClick={() => onClick(view.action)}
              {...longPress.handlers}
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
          </HoverCardPrimitive.Trigger>
          {changes && <UpdateChangesPanel changes={changes} />}
        </HoverCardPrimitive.Root>
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
 * What the update brings: the commits between this build and the release, grouped.
 *
 * The words are the authors' and the groups are the backend's (`src/changelog.rs`, which
 * also renders every release body on GitHub — one list, two places). Nothing here decides
 * what a change IS; this draws the answer.
 *
 * Bounded and scrolling, for the case that makes a changelog interesting: a build left
 * running for a week is 130-odd commits behind, and the panel must not become as tall as
 * the window. `max-h` in `rem` rather than `vh` — on a phone in landscape a `vh` cap is a
 * few lines, and this opens from a long press there.
 *
 * A hover card rather than a popover, and that is what keeps the focus where it is: this
 * opens under the pointer on a control the user may be about to press, and a popover would
 * move the caret into the panel the moment it appeared.
 */
function UpdateChangesPanel({ changes }: { changes: UpdateChanges }) {
  // What a reader can see, and a count of the work — the split is `readerChanges`, off the
  // flag the backend sets. This file recognises no heading of its own.
  const { groups, internal } = readerChanges(changes);
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-testid="update-changes"
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-border/60 bg-popover p-3 text-popover-foreground shadow-pop backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
      >
        <p
          data-testid="update-changes-summary"
          className="mb-2 text-[11px] font-medium text-text-dim"
        >
          {changesSummary(changes)}
        </p>
        <div className="max-h-[19rem] overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={group.title} className="mb-2 last:mb-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                {group.title}
              </p>
              <ul className="flex flex-col gap-1">
                {group.changes.map((change, index) => (
                  <li
                    // The subject is not unique — "docs: a note" happens twice in a week —
                    // so the key is the position inside its own group, which is stable for
                    // as long as the list is (it is replaced whole, never edited).
                    key={`${group.title}-${index}`}
                    data-testid="update-change"
                    className="text-[11px] leading-snug text-text"
                  >
                    {change.breaking && (
                      <span className="mr-1 font-semibold uppercase text-warning">
                        Breaking
                      </span>
                    )}
                    {change.scope && (
                      // The em dash is what keeps "calendar join a meeting" from reading as
                      // one sentence, and it is the separator the release notes use for the
                      // same pair — one list, one spelling.
                      <span className="font-medium text-text-dim">{change.scope} — </span>
                    )}
                    {change.summary}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {/* The work, as one line. OUTSIDE the scroller, with the heading, because it is a
            statement ABOUT the list rather than an entry in it — and because a reader who
            never scrolls to the foot of a long update would otherwise not see it at all. */}
        {internal > 0 && (
          <p
            data-testid="update-changes-internal"
            className="mt-2 text-[11px] leading-snug text-text-faint"
          >
            {internalChangesNote(internal)}
          </p>
        )}
      </HoverCardPrimitive.Content>
    </HoverCardPrimitive.Portal>
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
