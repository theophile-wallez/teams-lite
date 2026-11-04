// Says out loud that sign-in is broken, and offers the one action that fixes it.
//
// WHY IT EXISTS. The Intune container's login keyring re-locks on its own, roughly
// every eighteen hours. The identity broker then answers no token call at all, and
// nothing else changes: the socket stays up, the backend stays `active (running)`, the
// live dot stays green — and the app shows an empty sidebar with a truncated eleven-
// pixel `error:` line, which a pending-update notice used to replace outright. That
// happened twice, and both times the app's own answer to "why is it empty" was nothing.
// (The update has its own row now — see update-button.tsx — so it hides nothing.)
//
// It sits in the sidebar above the status bar, in flow, so it appears on every tab
// (Chats, Channels, Mail, Calendar) and pushes no content off screen. Deliberately NOT
// a full-screen overlay: `FatalOverlay` already owns "the app cannot work at all", and
// an outage that leaves cached reads working does not deserve the same treatment.
//
// In EMBEDDED mode the Intune container is the app's own (src/intune_embedded.rs), and the same
// banner says what that container is doing: being started (the first start downloads about
// 1.7 GB, and nothing needs pressing), waiting to be ENROLLED (the one remedy only a person can
// carry out, with the button that opens the Intune portal in the sign-in panel), being enrolled,
// enrolled but with no account in its broker (the same portal, opened to sign one in again), or
// down with nothing starting it — and never the host-mode sentence "sign in to Intune again",
// whose remedy is a command the image does not have. A host-mode backend sends `intune: null`,
// and draws exactly what this banner always drew.

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SecurityIcon } from "@hugeicons/core-free-icons";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import { brokerNeedsAttention, type BrokerStatus } from "~/lib/protocol";
import { brokerRemedy } from "~/lib/signin";

/** What the reader's own press of "Repair sign-in" left on this banner. A refusal carries
 *  `about`, the backend's view at the moment the press was MADE (see `brokerView`). */
type RepairState =
  | { kind: "idle" | "asking" }
  | { kind: "error"; message: string; about: string };

/** The part of the backend's view a refusal is about: which failure, whether a restart could
 *  fix it, and whether a repair is running. A refusal answers a press made against exactly this,
 *  so it is shown while this still holds and DROPPED the moment it moves — not merely hidden,
 *  or it came back with the button: a refusal under the `disconnected` the reader pressed on,
 *  then a `refused` that takes the button away, then `disconnected` again, put the old sentence
 *  back under a button nobody had pressed since. The `message` and the failure count are left
 *  out on purpose: neither changes what a press would do. */
function brokerView(broker: BrokerStatus): string {
  // The embedded container's helper and enrollment offer are part of it too: a refusal of a
  // press made while the container was down is not about the container being started since.
  const intune = broker.intune;
  return `${broker.signature}|${broker.can_repair}|${broker.repairing}|${intune?.helper ?? ""}|${intune?.can_enroll ?? ""}|${intune?.can_portal_sign_in ?? ""}`;
}

export function BrokerBanner() {
  const broker = useAppState((s) => s.brokerStatus);
  // A null status is silence, on purpose: the mock and any older backend never send
  // one, and a banner that showed up by default would be worse than the bug.
  if (!brokerNeedsAttention(broker) || !broker) return null;
  return <ShownBrokerBanner broker={broker} />;
}

/** The banner itself, mounted only while sign-in is broken.
 *
 *  A component of its own so the PRESS's state dies with the banner. This sidebar is never
 *  unmounted, and the keyring re-locks roughly every eighteen hours — so a "Repairing…" or a
 *  refusal held by the outer component outlived the outage it was about and greeted the NEXT
 *  one, a day later, with a disabled button over a repair nobody had asked for. */
function ShownBrokerBanner({ broker }: { broker: BrokerStatus }) {
  const controller = useController();
  // The served session, because an ENROLLMENT this page started is one the banner has to stop
  // offering at once — the portal helper takes the slot a moment after the press — and one the
  // reader put away is one it can bring back.
  const session = useAppState((s) => s.signin);
  const [repair, setRepair] = useState<RepairState>({ kind: "idle" });

  // `asking` covers the round trip and nothing more. Once the backend has taken the press, its
  // own `repairing` is the truth: it stays up through the repair and says when the unit ends,
  // and a repair that ended WITHOUT fixing sign-in has to hand the button back — held here
  // until the banner went away, it would stay "Repairing…" for as long as the outage lasted.
  const busy = repair.kind === "asking" || broker.repairing;
  // Exactly one remedy, ever, and the choice is a pure function so it can be tested: a banner
  // offering both "restart the container" and "sign in here" would ask the reader to know
  // which failure they have, which is the thing they opened the app to be told.
  const remedy = brokerRemedy(broker, session);

  // A refusal goes when the backend's view moves away from the one it answered: a repair that
  // something else started (the health check, the other backend, another page), a failure that
  // changed. Keyed on the view at the PRESS rather than on "the view changed", for two reasons.
  // A refusal that lands after the view has ALREADY moved is about a state the reader is no
  // longer looking at — "its login keyring is unlocked" under a `keyring_locked` banner — and a
  // reset that only fires on a change never sees it, so it is dropped on arrival here, which is
  // why `repair` is a dependency too. And this page's own optimistic flag goes up and comes back
  // down around every press, the rollback landing in the same breath as the refusal: a reset
  // on any change was measured to keep the sentence, but only because the rollback reaches
  // React before this component's own `catch` does — an order nothing here controls.
  const view = brokerView(broker);
  useEffect(() => {
    if (repair.kind === "error" && repair.about !== view) setRepair({ kind: "idle" });
  }, [repair, view]);

  const onRepair = async () => {
    const about = view;
    setRepair({ kind: "asking" });
    try {
      await controller.repairBroker();
      setRepair({ kind: "idle" });
    } catch (e) {
      // The backend's own sentence, shown under the button: a keyring that is not locked is
      // REFUSED in words, because a restart would take sign-in down for a minute and fix
      // nothing — and a press that silently did nothing would look like one that worked.
      setRepair({ kind: "error", message: e instanceof Error ? e.message : String(e), about });
    }
  };

  return (
    <div
      data-testid="broker-banner"
      data-signature={broker.signature}
      // `status`/polite, never `alert`: this stays on screen for minutes, and an
      // assertive live region would interrupt a screen reader mid-sentence.
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex shrink-0 flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 shadow-chip"
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon
          icon={SecurityIcon}
          className="mt-0.5 size-4 shrink-0 text-destructive"
          strokeWidth={1.8}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-destructive">Sign-in is broken</p>
          <p data-testid="broker-banner-message" className="mt-0.5 text-[11px] leading-snug text-text-dim">
            {broker.message} You're seeing the history stored on this machine. Nothing new arrives,
            and nothing can be sent, until it works again.
          </p>
        </div>
      </div>

      {remedy.kind === "starting" ? (
        // EMBEDDED: the app is starting its own Intune container. Nothing to press — the boot is
        // already the remedy, and it is under way — so a status row with the spinner rather than
        // a button, and the sentence says what it costs when it is the FIRST start: the 1.7 GB
        // pull, which on a slow link is most of an hour and must not read as a hang.
        <div className="flex flex-col gap-1.5">
          <p
            data-testid="broker-starting"
            className="flex items-center gap-2 text-xs font-medium text-foreground"
          >
            <FadeArc className="size-4" />
            {remedy.firstStart ? "Setting up the Intune container…" : "Starting the Intune container…"}
          </p>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.firstStart
              ? "This app runs its own Intune container, and its first start downloads about 1.7 GB, so this can take a while. Sign-in starts working once it is up — nothing to press."
              : "This app runs its own Intune container. Sign-in comes back on its own once it is up, in about a minute."}
          </p>
        </div>
      ) : remedy.kind === "enroll" ? (
        // EMBEDDED: the container is up and holds no device registration, so nothing the broker
        // does can sign anybody in on it. Enrolling is the one remedy, and it is a person's: the
        // press opens the Intune portal — running inside the app's own container — in the same
        // panel a sign-in uses, and they sign in with their work account there.
        <div className="flex flex-col gap-1.5">
          <Button size="sm" data-testid="broker-enroll" onClick={() => void controller.startEnroll()}>
            Enroll this device
          </Button>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            This app's own Intune container has not been enrolled yet. This opens the Intune portal
            inside it: you sign in with your work account, and the container becomes a device of
            your organization.
          </p>
        </div>
      ) : remedy.kind === "portal_signin" ? (
        // EMBEDDED: enrolled, and its broker holds no account — an imported backup whose account
        // did not come along, or one removed in the portal. The portal is how an account is added
        // on an enrolled device, so the same press opens it, for that; the host-mode sentence this
        // used to fall through to sent the reader to a command the image does not have.
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            data-testid="broker-portal-signin"
            onClick={() => void controller.startEnroll("account")}
          >
            Sign in through the Intune portal
          </Button>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            This device is enrolled, but its identity broker holds no account. This opens the
            Intune portal inside this app's own Intune container: you sign in with your work
            account there, and sign-in comes back.
          </p>
        </div>
      ) : remedy.kind === "enrolling" ? (
        // EMBEDDED: the portal is open for a session, or still closing after one. Offering the
        // press again would be a control that reports a refusal (one helper at a time); what the
        // reader may want instead is the panel they put away — which only exists HERE when this
        // page's backend holds the live session. A portal this page's own session has ENDED is
        // closing (its helper closes it, which takes seconds, and the slot is free only once it
        // has gone); one with no session of this page's behind it is said as what it is:
        // something that ends on its own.
        <div className="flex flex-col gap-1.5">
          {remedy.session === "live" ? (
            <Button size="sm" data-testid="broker-enroll-show" onClick={() => controller.reopenSignin()}>
              {remedy.purpose === "account" ? "Show the Intune portal" : "Show the enrollment"}
            </Button>
          ) : null}
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.session === "live"
              ? remedy.purpose === "account"
                ? "The Intune portal is open in the sign-in panel. Sign-in starts working once your account is signed in there."
                : "The Intune portal is open in the sign-in panel. Sign-in starts working once the device is enrolled."
              : remedy.session === "closing"
                ? "The Intune portal is still closing inside this app's Intune container, so nothing else can be started on it yet — usually for a few seconds, and within half an hour at the latest."
                : "The Intune portal is still open inside this app's Intune container, so nothing else can be started on it yet. It closes on its own within half an hour."}
          </p>
        </div>
      ) : remedy.kind === "stopped" ? (
        // EMBEDDED: down, and nothing is starting it. The host-mode fallback — "sign in to Intune
        // again" — would be false here, and there is no press that would help that the app is not
        // already going to make: its health check boots the container again on its own.
        <div className="flex flex-col gap-1.5">
          <p data-testid="broker-stopped" className="text-xs font-medium text-foreground">
            {remedy.firstStart
              ? "The Intune container is not set up yet"
              : "The Intune container is not running"}
          </p>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.firstStart
              ? "Its last setup did not finish. The app tries again on its own; this container's log says why the last attempt failed."
              : "The app starts it again on its own. If it does not come back, this container's log says why."}
          </p>
        </div>
      ) : remedy.kind === "embedded_other" ? (
        // EMBEDDED, up, and nothing on this banner applies. Never the host-mode fallback below:
        // its remedy is `intune-container` on the machine, and this image has none — so the words
        // say what is true and where the cause is written down.
        <div className="flex flex-col gap-1.5">
          <p data-testid="broker-embedded-other" className="text-xs font-medium text-foreground">
            {remedy.registered
              ? "The Intune container is up and enrolled"
              : "The Intune container is up, and not enrolled"}
          </p>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.registered
              ? "Its identity broker still cannot sign in, and nothing this window can press fixes that. This container's log says why."
              : "It cannot be enrolled from this window right now. This container's log says why."}
          </p>
        </div>
      ) : remedy.kind === "signin" ? (
        // The failure a container restart cannot fix, and the whole reason this banner grew a
        // second button: the broker is asking a human, and this brings its own sign-in window
        // to whichever browser the app is being read in (see signin-panel.tsx and SIGN-IN.md).
        // Where the words used to say "it needs you to sign in to Intune again" — true, and a
        // dead end that cost the reader an SSH session, an Xvfb, a VNC server and about forty
        // minutes — there is now a button that does it.
        <div className="flex flex-col gap-1.5">
          <Button size="sm" data-testid="broker-signin" onClick={() => void controller.startSignin()}>
            Sign in here
          </Button>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            This opens Microsoft's own sign-in page, running on the machine. Usually it finishes
            on its own; if not, you type your password and match the number on your phone.
          </p>
        </div>
      ) : remedy.kind === "blocked" ? (
        // A sign-in IS what this failure needs, and this machine cannot serve one: the broker's
        // display is gone, or it has none. The button stays visible and inert for the reason the
        // old branch below gives, and the backend's own sentence says what to do — in flow, so a
        // phone gets it too.
        <div className="flex flex-col gap-1.5">
          <Button size="sm" disabled data-testid="broker-signin" className="pointer-events-none">
            Sign in here
          </Button>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.message}
          </p>
        </div>
      ) : remedy.kind === "repair_blocked" ? (
        // A container restart IS what this failure needs, and this backend may not make one —
        // teams-lite's container image cannot restart the host's Intune container. The button
        // stays visible and inert for the reason the last branch gives, and the backend's own
        // sentence names who can: the host's CLI, or a host install's health check.
        <div className="flex flex-col gap-1.5">
          <Button size="sm" disabled data-testid="broker-repair" className="pointer-events-none">
            Repair sign-in
          </Button>
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            {remedy.message}
          </p>
        </div>
      ) : remedy.kind === "repair" ? (
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            data-testid="broker-repair"
            onClick={() => void onRepair()}
            disabled={busy}
          >
            {busy ? (
              <>
                <FadeArc className="size-4" />{" "}
                Repairing…
              </>
            ) : (
              "Repair sign-in"
            )}
          </Button>
          {/* The busy sentence used to promise the app would go quiet and reconnect: the
              repair restarted the backend too, so it did. It no longer does — the repair is a
              unit of the user's own systemd manager (in embedded mode, a helper of the app's
              own) and the backend stays up through it — so what the reader waits for is sign-in
              itself, which comes back without them. */}
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-faint">
            {busy
              ? "Restarting the Intune container. Sign-in comes back on its own once it is up again, in about a minute."
              : "This restarts the Intune container, which holds the sign-in keyring — only when that keyring is locked, the one thing a restart fixes."}
          </p>
          {/* Inside this branch rather than under the whole banner: the refusal is about the
              button above it, and a failure that moves to another remedy (a sign-in, or none)
              takes that button away — a sentence left behind would explain a press the reader
              can no longer make. Never under a running repair, which is the opposite of what it
              says; and only while the view it answered still holds, which is the commit before
              the effect above drops it for good. */}
          {repair.kind === "error" && !busy && repair.about === view && (
            <p data-testid="broker-repair-error" className="text-[11px] leading-snug text-destructive">
              {repair.message}
            </p>
          )}
        </div>
      ) : (
        // Keep the button visible but inert, and say why IN FLOW, in the same sentence
        // slot the repairable branch above uses. A missing button would read as
        // "nothing can be done" without ever saying so — but the words used to be a
        // HOVER TOOLTIP, and on a phone that is a sentence which does not exist: this
        // is the one broker failure whose remedy is the reader's own (go and sign in to
        // Intune again), and a touch screen showed them a dead button and nothing else.
        // Being in flow also puts it inside this banner's `aria-live` region, so it is
        // read out with the rest rather than only on a focus.
        <div className="flex flex-col gap-1.5">
          <Button size="sm" disabled data-testid="broker-repair" className="pointer-events-none">
            Repair sign-in
          </Button>
          {/* `text-dim` rather than the footnote's `text-faint` above: that one explains
              a button which already says what it does, and this one IS the remedy — the
              only line on this banner the reader can act on. */}
          <p data-testid="broker-repair-hint" className="text-[11px] leading-snug text-text-dim">
            Restarting the Intune container won't fix this one — it needs you to sign in to Intune
            again.
          </p>
        </div>
      )}
    </div>
  );
}
