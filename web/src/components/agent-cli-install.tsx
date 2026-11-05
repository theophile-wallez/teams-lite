/**
 * Installing an agent CLI from the app, in Settings › AI providers (src/agent_cli.rs is the
 * backend's half, lib/agent-cli.ts the pure one).
 *
 * Two pieces, and each is drawn only where it can change something:
 *
 * - **Per provider, ONE press at a time**: Install where the machine lacks the CLI, Update where a
 *   newer release of the copy this app installed is out, and the bar while either runs. What the
 *   press costs — the size and who it comes from — is stated BESIDE it before it is made, the rule
 *   the app's own update button holds for its 130 MB. A refusal is stated where the press was
 *   made, in the backend's own words, because an install that did not happen must never be left
 *   looking like it did.
 * - **For every CLI this app installed, the switch that keeps them current**, with when the backend
 *   last asked and a press that asks now. A machine that never installed one is shown neither: the
 *   backend asks about nothing it did not install, so the switch would decide nothing.
 *
 * The app never signs a CLI in: Anthropic forbids a third party to collect or relay Claude.ai
 * credentials. So once one is installed the row says how the user signs it in themselves, in a
 * terminal where the app runs, against the very binary and home this app starts.
 */

import { useEffect, useState } from "react";
import type { AgentBackend } from "~/lib/agent";
import {
  agentCliAction,
  agentCliCheckedLabel,
  agentCliIsShadowed,
  agentCliLastChecked,
  agentCliLoginHint,
  agentClisInstalledHere,
  megabytes,
} from "~/lib/agent-cli";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import { Button } from "./ui/button";

/** The install row of one provider: its one press, its bar, its version, and how to sign it in. */
export function AgentCliInstall(props: { backend: AgentBackend }) {
  const controller = useController();
  const { backend } = props;
  const cli = backend.cli;
  const [pressing, setPressing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  if (!cli) return null;
  const action = agentCliAction(backend);
  const shadowed = agentCliIsShadowed(backend);
  const hint = agentCliLoginHint(backend);
  // The backend's own reason outlives a reload; a refusal of THIS press is shown until the next.
  const error = refusal ?? (cli.error || null);

  const press = async () => {
    setPressing(true);
    setRefusal(null);
    try {
      await controller.installAgentCli(backend.name);
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : String(e));
    } finally {
      setPressing(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setRefusal(null);
    try {
      await controller.removeAgentCli(backend.name);
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  };

  const nothingToDraw = action.kind === "none" && !shadowed && !hint && !error && !cli.version;
  if (nothingToDraw) return null;

  return (
    <div
      data-testid="agent-cli"
      data-provider={backend.name}
      data-phase={cli.phase}
      data-managed={cli.managed}
      data-version={cli.version ?? ""}
      className="flex flex-col gap-2"
    >
      {(action.kind === "install" || action.kind === "update") && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button
            data-testid="agent-cli-action"
            data-kind={action.kind}
            size="sm"
            variant={action.kind === "install" ? "default" : "outline"}
            disabled={pressing}
            onClick={() => void press()}
            title={`Downloads ${action.cost}`}
          >
            {pressing ? <FadeArc className="size-4" /> : action.label}
          </Button>
          <span data-testid="agent-cli-cost" className="text-[11px] text-text-faint">
            {action.kind === "install"
              ? `Downloads ${action.cost}, checks it, and keeps it on this machine's data volume.`
              : `Downloads ${action.cost} and checks it. The run that is answering now keeps the version it started with.`}
          </span>
        </div>
      )}

      {action.kind === "busy" && (
        <div data-testid="agent-cli-progress" className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] text-text-dim">
            <FadeArc className="size-3.5" />
            <span data-testid="agent-cli-progress-label">{action.label}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-element">
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-300",
                action.percent === null && "w-1/3 animate-pulse",
              )}
              style={action.percent === null ? undefined : { width: `${action.percent}%` }}
            />
          </div>
        </div>
      )}

      {shadowed && (
        <p data-testid="agent-cli-shadowed" className="text-[11px] text-text-faint">
          This app also installed version {cli.version}, which is not used: {cli.path ?? "another copy"}{" "}
          comes first on the backend&apos;s PATH.
        </p>
      )}

      {hint && (
        <div data-testid="agent-cli-login" className="flex flex-col gap-1 text-[11px] text-text-faint">
          <span>{hint.lead}</span>
          <code
            data-testid="agent-cli-login-command"
            className="w-fit max-w-full overflow-x-auto rounded-md bg-element px-2 py-1 font-mono text-[11px] whitespace-nowrap text-foreground select-all"
          >
            {hint.command}
          </code>
          <span>{hint.alternative}</span>
        </div>
      )}

      {cli.version && action.kind !== "busy" && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-faint">
            {cli.installed_bytes ? `${megabytes(cli.installed_bytes)} on this machine` : "On this machine"}
          </span>
          <Button
            data-testid="agent-cli-remove"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? <FadeArc className="size-3.5" /> : "Remove"}
          </Button>
        </div>
      )}

      {error && (
        <span data-testid="agent-cli-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/** The switch that keeps the CLIs this app installed current, and a press that asks now. */
export function AgentCliUpdates() {
  const controller = useController();
  const status = useAppState((s) => s.agent);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // "Checked 3 minutes ago" has to keep being true while the pane stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!status || status.cli_auto_update === undefined || !agentClisInstalledHere(status)) return null;
  const on = status.cli_auto_update;

  const toggle = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await controller.setAgentCliAutoUpdate(!on);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setProblem(null);
    try {
      const answer = await controller.checkAgentClis();
      if (answer.check_error) setProblem(answer.check_error);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      data-testid="agent-cli-updates"
      data-auto-update={on}
      className="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-chip"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-foreground">Keep installed CLIs up to date</span>
          <span className="text-[11px] text-text-faint">
            The backend checks every few hours and installs a newer release of a CLI this app
            installed on its own. A CLI you installed yourself is left alone.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Update the CLIs this app installed automatically"
          data-testid="agent-cli-auto-update"
          disabled={busy}
          onClick={() => void toggle()}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            busy && "opacity-60",
            on ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              on ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span data-testid="agent-cli-checked" className="text-[11px] text-text-faint">
          {agentCliCheckedLabel(agentCliLastChecked(status), now)}
        </span>
        <Button
          data-testid="agent-cli-check"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? <FadeArc className="size-3.5" /> : "Check now"}
        </Button>
      </div>
      {problem && (
        <span data-testid="agent-cli-updates-error" className="text-xs text-destructive">
          {problem}
        </span>
      )}
    </div>
  );
}
