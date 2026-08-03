import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, CheckIcon, Loading02Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { AgentBackend } from "~/lib/agent";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * AI providers — which coding agent may answer an `@claude` message, and on which
 * model (see lib/agent.ts, src/agent_policy.rs).
 *
 * Three facts shape this pane, and each one is visible in it:
 *
 * - **A provider the machine has no CLI for can never answer.** It is marked "Not
 *   installed", its switch is disabled and it offers no model, rather than showing
 *   controls whose only effect would be a silent thread.
 * - **Every installed provider is on out of the box.** Turning one off is the user
 *   narrowing the set, so the switch reflects the backend's own answer and never a
 *   hopeful local guess.
 * - **The model is a free-form name, with suggestions.** `claude` takes an alias or a
 *   full model id; `opencode` takes `provider/model` for whichever providers that
 *   machine has authenticated. A fixed dropdown would be wrong on the next machine, so
 *   the suggestions fill the field rather than replacing it.
 *
 * Where a conversation is armed stays in that conversation's own header
 * (components/agent-menu.tsx) — that consent belongs where the user can see who reads
 * the thread. This pane is only about the machine's own tools.
 */
export function AiProvidersSettings() {
  const status = useAppState((s) => s.agent);
  const backends = status?.backends ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="ai-providers-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={SparklesIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">AI providers</h3>
          <p className="text-[13px] text-text-faint">
            The coding agents this machine can run when you write their prefix in a
            conversation you armed. Choose which ones answer, and on which model.
          </p>
        </div>
      </div>

      {status === null ? (
        <p
          data-testid="ai-providers-pending"
          className="rounded-xl bg-card p-4 text-[13px] text-text-dim shadow-chip"
        >
          The backend has not said yet which providers this machine holds.
        </p>
      ) : !status.enabled ? (
        <p
          data-testid="ai-providers-read-only"
          className="rounded-xl bg-card p-4 text-[13px] text-text-dim shadow-chip"
        >
          This backend is read-only, so no provider ever answers.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {backends.map((backend) => (
            <ProviderRow key={backend.name} backend={backend} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One provider: whether it is installed, whether it answers, and which model it runs. */
function ProviderRow(props: { backend: AgentBackend }) {
  const controller = useController();
  const { backend } = props;

  const [model, setModel] = useState(backend.model ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The backend's own answer is the truth: re-sync when it changes (a write landing,
  // another window changing it, a reconnect).
  useEffect(() => {
    setModel(backend.model ?? "");
  }, [backend.model]);

  const save = async (patch: { enabled?: boolean; model?: string }) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await controller.setAgentProvider(backend.name, patch);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stored = backend.model ?? "";
  const dirty = model.trim() !== stored;
  const on = backend.available && backend.enabled;

  return (
    <div
      data-testid="ai-provider"
      data-provider={backend.name}
      data-available={backend.available}
      data-enabled={backend.enabled}
      className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-chip"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg shadow-chip",
              on ? "bg-primary/10 text-primary" : "bg-element text-text-faint",
            )}
          >
            <HugeiconsIcon icon={BotIcon} className="size-5" strokeWidth={1.5} />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              {backend.name}
              {backend.available ? (
                <span
                  data-testid="ai-provider-availability"
                  data-state="installed"
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
                >
                  <HugeiconsIcon icon={CheckIcon} className="size-3" strokeWidth={2.5} /> Installed
                </span>
              ) : (
                <span
                  data-testid="ai-provider-availability"
                  data-state="missing"
                  className="rounded-full bg-element px-1.5 py-0.5 text-[10px] font-semibold text-text-faint"
                >
                  Not installed
                </span>
              )}
            </span>
            <span className="truncate text-[11px] text-text-faint">
              {backend.available
                ? `Write ${backend.prefix} in an armed conversation to ask for an answer.`
                : `This machine has no ${backend.name} command, so it can never answer.`}
            </span>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Enable the ${backend.name} provider`}
          data-testid="ai-provider-toggle"
          disabled={busy || !backend.available}
          onClick={() => void save({ enabled: !backend.enabled })}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            busy && "opacity-60",
            backend.available ? "cursor-pointer" : "cursor-not-allowed opacity-40",
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

      {/* No CLI, no model to choose: a field that could never change a run is a
          question with no answer. */}
      {backend.available && (
        <label className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
          <span className="text-[13px] font-medium text-foreground">Model</span>
          <div className="flex items-center gap-2">
            <Input
              data-testid="ai-provider-model-input"
              value={model}
              placeholder={`Default — whatever ${backend.name} is configured for`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) void save({ model: model.trim() });
              }}
            />
            <Button
              size="sm"
              data-testid="ai-provider-model-save"
              disabled={busy || !dirty}
              onClick={() => void save({ model: model.trim() })}
            >
              {busy ? (
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-4 animate-spin"
                  strokeWidth={1.8}
                />
              ) : (
                "Save"
              )}
            </Button>
          </div>

          {backend.models.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {backend.models.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  data-testid="ai-provider-model-suggestion"
                  data-value={suggestion}
                  disabled={busy}
                  onClick={() => {
                    setModel(suggestion);
                    void save({ model: suggestion });
                  }}
                  className={cn(
                    "rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    stored === suggestion
                      ? "bg-primary/12 text-primary"
                      : "bg-element text-text-dim hover:text-foreground",
                  )}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <span className="text-[11px] text-text-faint">
            {stored
              ? `Runs ${backend.name} on ${stored}.`
              : `Leave it empty to run whatever ${backend.name} is configured for.`}
            {stored && (
              <button
                type="button"
                data-testid="ai-provider-model-clear"
                disabled={busy}
                onClick={() => {
                  setModel("");
                  void save({ model: "" });
                }}
                className="ml-1.5 text-primary underline underline-offset-2 hover:opacity-80"
              >
                Use the default
              </button>
            )}
          </span>
        </label>
      )}

      {error ? (
        <span data-testid="ai-provider-error" className="text-xs text-destructive">
          {error}
        </span>
      ) : (
        saved && (
          <span
            data-testid="ai-provider-saved"
            className="flex items-center gap-1 text-xs text-emerald-600 animate-in fade-in-0 zoom-in-95 duration-200 ease-out dark:text-emerald-400"
          >
            <HugeiconsIcon icon={CheckIcon} className="size-3.5" strokeWidth={2} /> Saved
          </span>
        )
      )}
    </div>
  );
}
