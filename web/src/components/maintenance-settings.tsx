import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import {
  checkView,
  restartForces,
  restartPhaseFor,
  restartView,
  RESTART_STALLED_MS,
  type CheckPhase,
  type MaintenanceView,
  type RestartPhase,
} from "~/lib/maintenance";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";

/**
 * The two things the user can do to the app itself: ask whether a newer build exists, and
 * restart the backend.
 *
 * Neither is about Teams, which is why they are here rather than in a conversation's header
 * or in the sidebar. Both exist for the same reason: this app is read from a PHONE, over a
 * tailnet, and the machine it runs on is somewhere else. Everything the user could otherwise
 * do about a backend that has gone quiet, or about a release published an hour ago, needed a
 * terminal on that machine.
 *
 * What each row is worth on its own:
 *
 *   * **Check for updates** — the backend already polls every two minutes
 *     (`spawn_release_poll`), so this is rarely the only way to learn about a release. It is
 *     the way to learn NOW, and — more usefully — the way to get an ANSWER: a poll that finds
 *     nothing new changes nothing on screen, so "am I up to date?" was a question this app
 *     could not answer at all.
 *   * **Restart the backend** — the one repair for a process that answers reads and has
 *     stopped doing something else. It is deliberately not a fix for a broken SIGN-IN: that
 *     one has its own button, on its own banner, because it restarts the Intune container
 *     instead (see broker-banner.tsx).
 *
 * The words for every state are `~/lib/maintenance.ts`, so they are unit-tested; this file
 * holds the one thing a pure function cannot: whether the socket really went down and came
 * back, which is the only proof this page has that the restart it asked for happened.
 */
export function MaintenanceSettings() {
  return (
    <section className="flex flex-col gap-4" data-testid="maintenance-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={Refresh01Icon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">This app</h3>
          <p className="text-[13px] text-text-faint">
            The app itself, rather than your Teams account: whether a newer build has been
            published, and the backend this page talks to.
          </p>
        </div>
      </div>

      <UpdateCheckRow />
      <RestartRow />
    </section>
  );
}

/** Ask GitHub now. The row states what the app does on its own, so the button reads as
 *  "sooner" rather than as the only thing that ever looks. */
function UpdateCheckRow() {
  const controller = useController();
  const [phase, setPhase] = useState<CheckPhase>({ kind: "idle" });
  const view = checkView(phase);

  const check = async () => {
    setPhase({ kind: "asking" });
    try {
      setPhase({ kind: "answered", result: await controller.checkForUpdate() });
    } catch (e) {
      // Only a refused or unanswered REQUEST lands here: GitHub being unreachable is an
      // outcome the backend reports, so it is a sentence rather than a thrown failure.
      setPhase({ kind: "failed", error: e });
    }
  };

  return (
    <MaintenanceRow
      title="Check for updates"
      subtitle="teams-lite looks every couple of minutes on its own. This asks GitHub now."
      testId="update-check"
      view={view}
      onPress={() => void check()}
    />
  );
}

/** Restart the backend, and say what really became of the request.
 *
 *  The socket is the evidence: it drops when the backend goes and returns when it is back, so
 *  a restart that happened is one this page watched happen. Nothing dropping inside
 *  {@link RESTART_STALLED_MS} is the launcher not being there — the backend accepted, asked,
 *  and nobody carried it out — and saying so beats a spinner that never ends. */
function RestartRow() {
  const controller = useController();
  const live = useAppState((s) => s.live);
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  // Whether the connection has actually gone since the restart was accepted. A ref rather
  // than state: it is evidence gathered between renders, and it must not itself cause one.
  const wentDown = useRef(false);
  const view = restartView(phase);

  // The restart really happened: the socket went, and it is back.
  useEffect(() => {
    if (phase.kind !== "restarting") return;
    if (live !== "connected") {
      wentDown.current = true;
      return;
    }
    if (wentDown.current) setPhase({ kind: "done" });
  }, [live, phase.kind]);

  // Or nothing took it down at all. A connection that went and has not returned stays
  // `restarting` on purpose: the backend is down, the whole app already says so, and this row
  // must not claim a failure while the thing it asked for is still on its way.
  useEffect(() => {
    if (phase.kind !== "restarting") return;
    const timer = setTimeout(() => {
      if (!wentDown.current) setPhase({ kind: "stalled" });
    }, RESTART_STALLED_MS);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  const restart = async () => {
    const force = restartForces(phase);
    wentDown.current = false;
    setPhase({ kind: "asking" });
    try {
      setPhase(restartPhaseFor(await controller.restartBackend(force)));
    } catch (e) {
      setPhase({ kind: "failed", error: e });
    }
  };

  return (
    <MaintenanceRow
      title="Restart the backend"
      subtitle="Every open page loses its connection for a few seconds and reconnects on its own. Your messages are on this machine, so nothing is lost."
      testId="restart-backend"
      view={view}
      armed={phase.kind === "armed"}
      onPress={() => void restart()}
    />
  );
}

/** One row: what it is, what it costs, the button — and, only when there is something to
 *  report, a line under it.
 *
 *  The line is kept OUT of the row's own subtitle for the reason the update button keeps its
 *  cost in a title: this is a column of controls the user aims at, and a sentence that comes
 *  and goes moves the ones below it. Here it may grow the row, and it is worth it — a phone
 *  has no hover, and what HAPPENED is the half the user acts on. */
function MaintenanceRow(props: {
  title: string;
  subtitle: string;
  testId: string;
  view: MaintenanceView;
  armed?: boolean;
  onPress: () => void;
}) {
  const { view } = props;
  return (
    <div
      data-testid={`${props.testId}-row`}
      className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-4 shadow-chip"
    >
      <div className="flex min-w-0 flex-1 basis-48 flex-col">
        <span className="text-[13px] font-medium text-foreground">{props.title}</span>
        <span className="text-[11px] text-text-faint">{props.subtitle}</span>
        {view.message && (
          <span
            data-testid={`${props.testId}-message`}
            className={cn(
              "mt-1.5 text-[11px] leading-snug",
              props.armed ? "text-destructive" : "text-text-dim",
            )}
          >
            {view.message}
          </span>
        )}
      </div>
      <Button
        size="sm"
        // Armed wears the destructive colour, exactly as an armed Delete does: the press it
        // is asking for ends a reply somebody in the thread is waiting on.
        variant={props.armed ? "destructive" : "secondary"}
        disabled={view.busy}
        data-testid={`${props.testId}-button`}
        onClick={props.onPress}
        className="shrink-0"
      >
        {view.busy && (
          <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={2} />
        )}
        {view.label}
      </Button>
    </div>
  );
}
