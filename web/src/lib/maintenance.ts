// teams-lite web — the two things the user can do TO this app, as pure functions.
//
// Settings › This app holds them (components/maintenance-settings.tsx): ask whether a newer
// build has been published, and restart the backend. Neither is about Teams at all — they
// are about the program in front of the user — and each one is a button whose whole
// difficulty is what it SAYS, so the words live here and the component only draws them.
//
// **Both report their outcome where the click was made.** That is the rule § Sending messages
// states for the composer and § The trackers states for the approval menu, and these two need
// it more than either: a check whose answer is "nothing new" produces no visible change
// anywhere else in the app, and a restart that nothing carried out looks exactly like a
// restart that worked.
//
// The restart is decided as a small state machine rather than as booleans, because it has
// two states nothing else in this app has: ARMED — the backend answered that a local agent
// is mid-reply, so the next press has to carry `force` — and STALLED, where the socket never
// dropped and the honest report is that nothing happened.

import type { BackendRestartResult, UpdateCheckResult } from "./protocol";

/** How long a restart may take before the page says nothing carried it out.
 *
 *  Generous next to what a restart costs: a launcher re-spawns the backend in about a
 *  second, and a supervised one is back within its unit's `RestartSec` — but that delay grows
 *  per consecutive restart (`RestartSteps` in packaging/systemd/teams-lite-backend.service),
 *  so a short window would call a slow-but-working restart a failure. What it really catches
 *  is the launcher that is not there at all. */
export const RESTART_STALLED_MS = 45_000;

/** What the update check is doing, and what it last found. */
export type CheckPhase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; result: UpdateCheckResult }
  | { kind: "failed"; error: unknown };

/** How far the user has taken a restart. */
export type RestartPhase =
  | { kind: "idle" }
  /** The RPC is in flight. */
  | { kind: "asking" }
  /** The backend refused once: a local agent is writing a reply. The next press forces it. */
  | { kind: "armed"; runs: number }
  /** Accepted. The socket is about to go, and the page's own reconnect is what ends this. */
  | { kind: "restarting" }
  /** The socket went and came back — the restart really happened. */
  | { kind: "done" }
  /** Nothing took the backend down inside {@link RESTART_STALLED_MS}. */
  | { kind: "stalled" }
  | { kind: "failed"; error: unknown };

/** What one of these rows draws. */
export type MaintenanceView = {
  /** The words on the button. */
  label: string;
  /** One line under the row, for what HAPPENED. Empty when there is nothing to report, so
   *  the row does not grow while nothing is going on. */
  message: string;
  /** The app is working on it: the button is inert and says so. */
  busy: boolean;
};

/** The update check's row. */
export function checkView(phase: CheckPhase): MaintenanceView {
  switch (phase.kind) {
    case "asking":
      return { label: "Checking…", message: "", busy: true };
    case "answered":
      return { label: "Check again", message: checkMessage(phase.result), busy: false };
    case "failed":
      return { label: "Check again", message: refusalSentence(phase.error), busy: false };
    default:
      return { label: "Check for updates", message: "", busy: false };
  }
}

/**
 * What the backend's answer means, in one sentence.
 *
 * Every outcome says something, including the two that are not news: a button whose press
 * produced no visible change reads as a button that does nothing, and "you are up to date"
 * is the commonest — and most reassuring — answer it can give.
 *
 * No sentence names a commit. That is the rule the update control already keeps (see
 * ./update.ts): a sha reads as a fault code, and there is one release to take.
 */
export function checkMessage(result: UpdateCheckResult): string {
  switch (result.outcome) {
    case "available":
      // The sidebar's own row is what TAKES it — this one only says it exists, and where.
      return "A newer build is available. The update button is at the foot of the sidebar.";
    case "current":
      return "This is the newest build.";
    case "busy":
      return "An update is already being taken — the button at the foot of the sidebar has it.";
    case "unsupported":
      // No `TEAMS_BUILD_REV`: nothing to compare a release against. Said rather than
      // answered "up to date", which would be a guess.
      return "This build was made from source, so there is no release to compare it with.";
    case "unknown":
      return "Could not tell whether a newer build exists.";
    case "failed":
      return result.error
        ? `Could not reach GitHub — ${result.error}`
        : "Could not reach GitHub.";
  }
}

/** The restart's row. */
export function restartView(phase: RestartPhase): MaintenanceView {
  switch (phase.kind) {
    case "asking":
      return { label: "Restarting…", message: "", busy: true };
    case "armed":
      return {
        label: "Restart anyway",
        message: agentWarning(phase.runs),
        busy: false,
      };
    case "restarting":
      return {
        label: "Restarting…",
        // The socket is going down with it, so the page cannot ask again — its own
        // reconnect is what ends this state.
        message: "The page reconnects when the backend is back.",
        busy: true,
      };
    case "done":
      return { label: "Restart", message: "The backend restarted.", busy: false };
    case "stalled":
      // Nothing was lost: the backend that was running is still running. The one thing the
      // user can do about it is start the app the way this install is started.
      return {
        label: "Restart",
        message:
          "Nothing restarted the backend — the one that was running is still there. " +
          "Restart it the way this install is started.",
        busy: false,
      };
    case "failed":
      return { label: "Restart", message: refusalSentence(phase.error), busy: false };
    default:
      return { label: "Restart", message: "", busy: false };
  }
}

/** Does the next press carry `force`? Only from the armed state, and never by default: the
 *  point of the arming is that the user answered a question about a reply being written. */
export function restartForces(phase: RestartPhase): boolean {
  return phase.kind === "armed";
}

/** Where the backend's answer leaves the row. The refusal-shaped answer (`restarted: false`)
 *  is the arming, and it is the ONLY thing that arms one — the count is a fact only the
 *  backend holds, because a run started from the user's phone is one this page never saw. */
export function restartPhaseFor(result: BackendRestartResult): RestartPhase {
  if (result.restarted) return { kind: "restarting" };
  if (result.blocked === "agent") return { kind: "armed", runs: Math.max(1, result.runs ?? 1) };
  // A `restarted: false` this page does not recognise. Treated as "nothing happened" rather
  // than as a restart in flight, so the row never claims something the backend did not say.
  return { kind: "stalled" };
}

/** What a restart would cost a reply that is being written, in the words the user decides
 *  with. It never says the answer is LOST: whichever backend comes up rewrites that message
 *  as interrupted (`repair_abandoned_agent_runs`), so the thread is told. */
function agentWarning(runs: number): string {
  const what = runs === 1 ? "A reply is" : `${runs} replies are`;
  const it = runs === 1 ? "it" : "them";
  return `${what} being written by a local agent right now. A restart ends ${it} where ${
    runs === 1 ? "it stands" : "they stand"
  }, and the thread is told the answer was interrupted.`;
}

/**
 * A backend refusal, as a sentence for the person who pressed the button.
 *
 * The backend writes its refusals for whoever holds the socket, so they open with the RPC's
 * own name and with `refused:` — neither of which means anything to a reader (the same
 * reading ./call-failure.ts makes of a call's refusal). What is left is already a sentence:
 * these two methods refuse for reasons the user can act on — no launcher, no write token, a
 * read-only backend — so the words are kept rather than replaced.
 */
function refusalSentence(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  if (!raw) return "That did not happen, and nothing said why.";
  const withoutMethod = raw.replace(/^[a-z][a-z0-9_]*:\s*/, "");
  const withoutRefused = withoutMethod.replace(/^refused:\s*/, "");
  const sentence = withoutRefused || withoutMethod || raw;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
