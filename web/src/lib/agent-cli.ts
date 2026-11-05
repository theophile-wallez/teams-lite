/**
 * Installing an agent CLI from the app — the pure half of Settings › AI providers' install row
 * (src/agent_cli.rs is the backend's).
 *
 * Every decision the row makes is here, so it is tested without a browser: which one press a
 * provider offers (install, update, nothing), what the bar says while an install runs, and the
 * sentences that name what a press costs before it is made — the rule the app's own update button
 * holds for its 130 MB.
 */

import type { AgentBackend, AgentCli, AgentCliPhase, AgentStatus } from "./agent";

/** The one press a provider's row offers. */
export type AgentCliAction =
  /** Nothing to press: the CLI is here and current, or this machine cannot install it. */
  | { kind: "none" }
  /** The CLI is missing and this machine can fetch it. */
  | { kind: "install"; label: string; cost: string }
  /** A newer release of the copy this app installed is out. */
  | { kind: "update"; label: string; cost: string }
  /** An install is under way; `percent` is null until the download states its length. */
  | { kind: "busy"; label: string; percent: number | null };

/** "about 125 MB" — the size beside a button, rounded the way a person says it. */
export function aboutMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 100) return `about ${Math.round(mb / 10) * 10} MB`;
  if (mb >= 10) return `about ${Math.round(mb / 5) * 5} MB`;
  return `about ${Math.max(1, Math.round(mb))} MB`;
}

/** Exactly how much is on disk, for the Remove row: "340 MB". */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** What the bar says while an install runs. */
export function agentCliPhaseLabel(phase: AgentCliPhase, percent: number | null): string {
  switch (phase) {
    case "resolving":
      return "Checking the release…";
    case "downloading":
      return percent === null ? "Downloading…" : `Downloading… ${percent}%`;
    case "unpacking":
      return "Verifying…";
    case "idle":
      return "";
  }
}

/** How far a download is, as a whole percent, or null while its length is unknown. */
export function agentCliPercent(cli: Pick<AgentCli, "received" | "total">): number | null {
  if (cli.total <= 0) return null;
  return Math.min(100, Math.floor((cli.received * 100) / cli.total));
}

/**
 * The one press a provider's row offers.
 *
 * An install is offered only where it would work: the backend says this machine can install it
 * (`installable` is false on a read-only backend and on a platform its vendor publishes no build
 * for), and nothing on this machine already answers that prefix. An UPDATE is offered only for the
 * copy this app installed AND runs — the user's own install, found first on PATH, is theirs to
 * update.
 */
export function agentCliAction(backend: AgentBackend): AgentCliAction {
  const cli = backend.cli;
  if (!cli) return { kind: "none" };
  if (cli.phase !== "idle") {
    const percent = cli.phase === "downloading" ? agentCliPercent(cli) : null;
    return { kind: "busy", label: agentCliPhaseLabel(cli.phase, percent), percent };
  }
  if (!cli.installable) return { kind: "none" };
  const cost = `${aboutMegabytes(cli.download_bytes)} from ${cli.publisher}`;
  if (!backend.available) return { kind: "install", label: "Install", cost };
  if (cli.managed && cli.update_available && cli.latest) {
    return { kind: "update", label: `Update to ${cli.latest}`, cost };
  }
  return { kind: "none" };
}

/** Whether this app's copy is on disk but NOT what runs — the user's own install comes first. */
export function agentCliIsShadowed(backend: AgentBackend): boolean {
  const cli = backend.cli;
  return Boolean(cli && cli.version && !cli.managed && backend.available);
}

/** The one line under a provider this app installed: which version, and whether it is current. */
export function agentCliVersionLine(backend: AgentBackend): string | null {
  const cli = backend.cli;
  if (!cli?.version || !cli.managed) return null;
  if (cli.update_available && cli.latest) {
    return `Version ${cli.version}, installed by this app — ${cli.latest} is out.`;
  }
  return `Version ${cli.version}, installed by this app.`;
}

/** One frame of `agent_cli_progress`. */
export type AgentCliProgress = {
  provider: string;
  phase: AgentCliPhase;
  received: number;
  total: number;
};

/**
 * Fold one progress frame into the status, returning the SAME object when it changes nothing — a
 * frame for a provider this status does not list, or one from a backend too old to describe its
 * installs — so the store does not re-render the app for it.
 */
export function withAgentCliProgress(status: AgentStatus | null, frame: unknown): AgentStatus | null {
  if (!status || !isProgress(frame)) return status;
  let changed = false;
  const backends = status.backends.map((backend) => {
    if (backend.name !== frame.provider || !backend.cli) return backend;
    changed = true;
    return {
      ...backend,
      cli: { ...backend.cli, phase: frame.phase, received: frame.received, total: frame.total, error: "" },
    };
  });
  return changed ? { ...status, backends } : status;
}

const PHASES: readonly AgentCliPhase[] = ["idle", "resolving", "downloading", "unpacking"];

function isProgress(frame: unknown): frame is AgentCliProgress {
  if (!frame || typeof frame !== "object") return false;
  const f = frame as Record<string, unknown>;
  return (
    typeof f.provider === "string" &&
    typeof f.phase === "string" &&
    (PHASES as readonly string[]).includes(f.phase) &&
    typeof f.received === "number" &&
    typeof f.total === "number"
  );
}

/** "Checked 2 hours ago" / "Never checked" — when the backend last asked upstream. */
export function agentCliCheckedLabel(checkedMs: number | null, nowMs: number): string {
  if (!checkedMs) return "Not checked yet";
  const minutes = Math.max(0, Math.round((nowMs - checkedMs) / 60_000));
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Checked ${Math.round(hours / 24)} days ago`;
}

/** The newest check across every CLI this app installed, or null when none was ever asked. */
export function agentCliLastChecked(status: AgentStatus | null): number | null {
  let newest: number | null = null;
  for (const backend of status?.backends ?? []) {
    const at = backend.cli?.checked_ms ?? null;
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** Whether any CLI on this machine was installed by this app — the switch and the check are about
 *  those alone, so with none there is nothing for them to say. */
export function agentClisInstalledHere(status: AgentStatus | null): boolean {
  return (status?.backends ?? []).some((backend) => Boolean(backend.cli?.version));
}
