// Says out loud that this window cannot act, when nothing else in it would show that.
//
// WHY IT EXISTS. The backend gates every outward and machine method on a token it mints
// per process and hands only to the user's own frontends (the write lock, see
// src/bin/server.rs). A page can end up holding one that backend does not accept — `teams`
// attached to a backend another instance spawned, whose token is pinned and therefore in no
// file; or `TEAMS_LITE_WS_URL` pointing this page's socket at a different backend. Reads
// keep answering in both: the sidebar fills, the history scrolls, the live dot stays green,
// and every send, reaction, read marker and update comes back refused. A user met it as
// "Update failed — try again" and went looking at their network.
//
// It sits beside BrokerBanner, in the sidebar above the status bar, for the same reasons:
// in flow (it pushes no content off screen), on every tab, and NOT a full-screen overlay —
// `FatalOverlay` owns "the app cannot work at all", and a window that still reads every
// message does not deserve that.

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";
import { writeLockNotice } from "~/lib/write-lock";

export function WriteLockBanner() {
  const lock = useAppState((s) => s.writeLock);
  const controller = useController();
  const [checking, setChecking] = useState(false);

  // Null, `unknown` and `read_only` are all silence — see `writeLockNeedsAttention`. The
  // mock and any older backend never answer, and a banner that appeared by default would
  // be worse than the bug it guesses at.
  const notice = writeLockNotice(lock);
  if (!notice) return null;

  const onCheck = async () => {
    setChecking(true);
    try {
      // Re-reads the token and asks again. A `held` answer empties this banner on its own,
      // because it is drawn from that state and nothing else.
      await controller.checkWriteLock();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      data-testid="write-lock-banner"
      data-pinned={lock?.pinned ? "true" : "false"}
      // `status`/polite, never `alert`: this stays on screen until the user mends it
      // outside the app, and an assertive live region would interrupt a screen reader
      // mid-sentence.
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex shrink-0 flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 shadow-chip"
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon
          icon={SquareLock02Icon}
          className="mt-0.5 size-4 shrink-0 text-destructive"
          strokeWidth={1.8}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-destructive">{notice.title}</p>
          <p
            data-testid="write-lock-banner-message"
            className="mt-0.5 text-[11px] leading-snug text-text-dim"
          >
            {notice.message}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Button
          size="sm"
          data-testid="write-lock-check"
          onClick={() => void onCheck()}
          disabled={checking}
        >
          {checking ? (
            <>
              <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />{" "}
              Checking…
            </>
          ) : (
            "Check again"
          )}
        </Button>
        <p data-testid="write-lock-banner-hint" className="text-[11px] leading-snug text-text-faint">
          {notice.hint}
        </p>
      </div>
    </div>
  );
}
