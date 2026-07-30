// Says out loud that sign-in is broken, and offers the one action that fixes it.
//
// WHY IT EXISTS. The Intune container's login keyring re-locks on its own, roughly
// every eighteen hours. The identity broker then answers no token call at all, and
// nothing else changes: the socket stays up, the backend stays `active (running)`, the
// live dot stays green — and the app shows an empty sidebar with a truncated eleven-
// pixel `error:` line that a pending-update notice can hide entirely. That happened
// twice, and both times the app's own answer to "why is it empty" was nothing.
//
// It sits in the sidebar above the status bar, in flow, so it appears on every tab
// (Chats, Channels, Mail, Calendar) and pushes no content off screen. Deliberately NOT
// a full-screen overlay: `FatalOverlay` already owns "the app cannot work at all", and
// an outage that leaves cached reads working does not deserve the same treatment.

import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useAppState, useController } from "./controller-context";
import { brokerNeedsAttention } from "~/lib/protocol";

type RepairState = { kind: "idle" | "asking" } | { kind: "error"; message: string };

export function BrokerBanner() {
  const broker = useAppState((s) => s.brokerStatus);
  const controller = useController();
  const [repair, setRepair] = useState<RepairState>({ kind: "idle" });

  // A null status is silence, on purpose: the mock and any older backend never send
  // one, and a banner that showed up by default would be worse than the bug.
  if (!brokerNeedsAttention(broker) || !broker) return null;

  const busy = repair.kind === "asking" || broker.repairing;

  const onRepair = async () => {
    setRepair({ kind: "asking" });
    try {
      await controller.repairBroker();
      // Stay in "asking": the repair takes about a minute, drops this socket on the
      // way, and clears itself when the backend reports a healthy broker again.
    } catch (e) {
      setRepair({ kind: "error", message: e instanceof Error ? e.message : String(e) });
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
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-destructive">Sign-in is broken</p>
          <p data-testid="broker-banner-message" className="mt-0.5 text-[11px] leading-snug text-text-dim">
            {broker.message} teams-lite can't read your chats, mail or calendar until it works
            again.
          </p>
        </div>
      </div>

      {broker.can_repair ? (
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            data-testid="broker-repair"
            onClick={() => void onRepair()}
            disabled={busy}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" strokeWidth={1.8} /> Repairing…
              </>
            ) : (
              "Repair sign-in"
            )}
          </Button>
          <p className="text-[11px] leading-snug text-text-faint">
            {busy
              ? "Restarting the Intune container. The app goes quiet for about a minute, then reconnects on its own."
              : "This restarts the Intune container, which holds the sign-in keyring."}
          </p>
        </div>
      ) : (
        // Keep the button visible but inert, and say why — the same pattern the
        // deliberately-unanswerable call button uses. A missing button would read as
        // "nothing can be done" without saying so.
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button size="sm" disabled data-testid="broker-repair" className="pointer-events-none">
                Repair sign-in
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Restarting the Intune container won't fix this one — it needs you to sign in to
            Intune again.
          </TooltipContent>
        </Tooltip>
      )}

      {repair.kind === "error" && (
        <p data-testid="broker-repair-error" className="text-[11px] leading-snug text-destructive">
          {repair.message}
        </p>
      )}
    </div>
  );
}
