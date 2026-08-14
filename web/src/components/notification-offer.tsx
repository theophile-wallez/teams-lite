// Notifications, OFFERED — one row at the foot of the sidebar, once per browser.
//
// The whole chain already worked and nobody had it on: measured on this machine's own
// store, ZERO devices were subscribed while the switch sat in Settings › Notifications
// for a fortnight. That is the bug this row fixes — a setting nobody finds is a feature
// that does not exist — and it is why the offer comes to the reader where they already
// look rather than waiting to be looked for. Settings stays the place they turn it off,
// and the place that explains a device which cannot have it at all.
//
// It is the UPDATE row's shape (see update-button.tsx), for the update row's reasons: it
// sits above the status line rather than inside it, it is an invitation so it wears the
// app's accent, and what a press COSTS is on the control itself. Three rules of its own,
// and `web/e2e/notification-settings.spec.ts` pins each:
//
//   • THE PRESS IS THE PERMISSION. `enablePush` asks the browser from inside this click,
//     because iOS refuses a prompt that does not come from a gesture — and because a
//     prompt the reader has read a sentence about is one they answer rather than dismiss.
//     Nothing in this app asks any other way (see lib/notify.ts).
//   • A REFUSAL IS SAID HERE, at the press, in the browser's own words. The rule the
//     composer holds for a failed send: an action that did not happen must never be left
//     looking like it did, and this one fails for reasons only the browser knows (a push
//     service switched off, a worker that will not register).
//   • ONE DISMISSAL IS FOR GOOD, per browser. The offer is worth making once; a row that
//     came back every launch would be a nag, and the switch is in Settings for ever.

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BellIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";
import { pushBlockerMessage, pushOffer } from "~/lib/push";

/** Per BROWSER, like every other client-side preference here: what this row offers is
 *  this device's own subscription, so a dismissal on the laptop must not silence the
 *  offer on the phone. */
const DISMISSED_KEY = "teams-lite:notification-offer-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // No storage (private mode, SSR): offer it. An offer shown twice costs a glance;
    // one that is never shown is the bug this row exists for.
    return false;
  }
}

export function NotificationOffer() {
  const push = useAppState((s) => s.push);
  const controller = useController();
  const [dismissed, setDismissed] = useState(readDismissed);

  const offer = pushOffer(push, dismissed);
  if (offer === null) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // The row is gone for this session either way.
    }
  };

  const enable = async () => {
    try {
      await controller.enablePush();
      // Asked once and answered: the offer is over on this device whatever happens next,
      // so a reader who later turns notifications OFF in Settings is not answered by this
      // row coming back to ask them again.
      dismiss();
    } catch {
      // The controller put the browser's own reason in `push.error`; the row shows it.
    }
  };

  return (
    <div
      data-testid="notification-offer"
      data-shape={offer}
      // Polite, not assertive: this appears while the reader is reading a conversation,
      // and it is an invitation rather than something that happened. The update row's
      // own choice, for the same reason.
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex shrink-0 flex-col gap-1"
    >
      <div className="flex items-start gap-2">
        {offer === "enable" ? (
          <Button
            data-testid="notification-offer-enable"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-2"
            disabled={push.busy}
            // The browser's prompt has to come out of this very click.
            onClick={() => void enable()}
            title="Get a notification on this device when somebody writes — even when teams-lite is closed"
          >
            <HugeiconsIcon icon={BellIcon} className="size-4 shrink-0" strokeWidth={1.6} />
            <span className="truncate">
              {push.busy ? "Turning on…" : "Turn on notifications"}
            </span>
          </Button>
        ) : (
          // Something the READER can undo and this app cannot: an iOS tab, or a page on
          // plain http. There is no press that would work, so the row is the sentence —
          // the one `pushBlockerMessage` already writes, keyed on the blocker itself
          // rather than a second spelling of Apple's rule or of the secure-context one.
          <p
            data-testid="notification-offer-advice"
            className="min-w-0 flex-1 text-[11px] leading-snug text-text-dim"
          >
            {pushBlockerMessage(push.blocker)}
          </p>
        )}
        <button
          type="button"
          data-testid="notification-offer-dismiss"
          aria-label="Dismiss"
          title="Don’t offer this again on this device"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>

      {push.error && (
        <p data-testid="notification-offer-error" className="text-[11px] leading-snug text-destructive">
          {push.error}
        </p>
      )}
    </div>
  );
}
