import { Toaster } from "sonner";

/**
 * Where a transient notice is drawn (see lib/notice.ts for what one is).
 *
 * Sonner does the part that was hand-rolled and wrong before — a timer per notice, one
 * stack, a pause while the pointer rests on it, and no motion under
 * `prefers-reduced-motion` — and this file decides only how it looks and where it sits.
 *
 * **The look is this app's, not the library's.** `unstyled` turns off sonner's own card
 * and the classes below are the ones the call notice already wore, so nothing about the
 * app's surface changed when the timer arrived. There is no close button: a notice this
 * app shows is one sentence that leaves on its own, and a control on it would say the
 * user has something to decide.
 *
 * **It sits where the call bar sits — bottom, right on a wide screen, spanning on a
 * phone — and never ON it.** `--notice-inset-bottom` is the reservation: the call bar
 * reports its own height into it (see call-bar.tsx), so a notice about a camera the
 * browser refused stacks ABOVE the card holding Hang up rather than over it. Below
 * 600px sonner spans the width itself, which is what the card does too: a pill in the
 * corner of a phone is a target nobody hits.
 */
export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      // The bottom inset clears the composer, exactly as the call bar's own does: a
      // card over the message box swallows the click that focuses it.
      offset={{ bottom: NOTICE_INSET, top: "1rem", left: "1rem", right: "1rem" }}
      mobileOffset={{
        bottom: NOTICE_INSET,
        top: "0.75rem",
        left: "0.75rem",
        right: "0.75rem",
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          // The two inks are ONE class list, keyed off sonner's own `data-type`, rather
          // than its `default` / `error` slots: those are concatenated, not merged, so
          // two plain colour utilities would be decided by the order Tailwind happened to
          // emit them in — which put `text-text-dim` over a failure. `text-destructive` is
          // the ink the composer's send failure uses, for the same reason: the user asked
          // for something that did not happen.
          toast:
            "pointer-events-auto flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-text-dim shadow-pop data-[type=error]:text-destructive",
          title: "leading-snug",
        },
      }}
    />
  );
}

/** The reservation the call bar writes into, with the inset a notice takes when nothing
 *  is drawn down there. `env()` keeps it above the home indicator on a phone. */
const NOTICE_INSET = "var(--notice-inset-bottom, var(--notice-inset-base))";
