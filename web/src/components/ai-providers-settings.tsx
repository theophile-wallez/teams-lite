import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import {
  agentBackendLabel,
  agentDefaultProvider,
  type AgentBackend,
  type AgentProviderPatch,
} from "~/lib/agent";
import { cn } from "~/lib/utils";
import { AgentLogo } from "./agent-logo";
import { AgentModelSelect } from "./agent-model-select";
import { useAppState, useController } from "./controller-context";

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
 * - **The model is chosen from the machine's own list.** The backend reads what this
 *   machine can really run (`agent_models::choices`) and names each model the way its
 *   vendor does, so the picker offers models rather than ids. It stays a picker and
 *   never a limit — the search field doubles as the free-form entry the RPC has always
 *   accepted, because a list that is right on this machine would be wrong on the next.
 * - **One of them is the DEFAULT, and Claude Code is it out of the box.** Every enabled
 *   provider answers its own prefix, so the default takes nothing away: it says which
 *   single one a surface with room for one row offers — a message's ⋯ menu. It is chosen
 *   here rather than in that menu because it is a fact about the machine, like the model.
 *   Exactly one provider carries it, so the row that has it shows a chip and offers no
 *   switch: it is moved by naming the other one.
 *
 * The providers are rows of one list, not a card each. A card frames one thing to say
 * it stands alone; these two are the same kind of thing, read in order, so the eye
 * should run down the names instead of stopping at every border. Each row wears its
 * vendor's own mark rather than a generic robot, because the mark is what the reader
 * recognises before reading a word.
 *
 * Where a conversation is armed stays in that conversation's own header
 * (components/conversation-menu.tsx) — that consent belongs where the user can see who reads
 * the thread. This pane is only about the machine's own tools.
 */
export function AiProvidersSettings() {
  const status = useAppState((s) => s.agent);
  const backends = status?.backends ?? [];
  const defaultProvider = agentDefaultProvider(status);

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
            conversation you armed. Choose which ones answer, on which model, and which one
            a message&rsquo;s ⋯ menu offers.
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
        <div className="flex flex-col rounded-xl bg-card shadow-chip">
          {backends.map((backend, index) => (
            <ProviderRow
              key={backend.name}
              backend={backend}
              isDefault={backend.name === defaultProvider}
              first={index === 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One provider: whether it is installed, whether it answers, which model it runs, and
 *  whether it is the one a message's ⋯ menu offers. */
function ProviderRow(props: { backend: AgentBackend; isDefault: boolean; first: boolean }) {
  const controller = useController();
  const { backend } = props;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: AgentProviderPatch) => {
    setBusy(true);
    setError(null);
    try {
      await controller.setAgentProvider(backend.name, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = agentBackendLabel(backend.name);
  const on = backend.available && backend.enabled;

  return (
    <div
      data-testid="ai-provider"
      data-provider={backend.name}
      data-available={backend.available}
      data-enabled={backend.enabled}
      data-default={props.isDefault}
      className={cn("flex flex-col gap-3 p-4", !props.first && "border-t border-border-subtle")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* The vendor's own artwork, bare: it carries its own colour, and a tinted
              chip behind it would read as this app's badge rather than theirs. A
              provider that cannot answer wears it greyed, which says "off" without a
              word. */}
          <AgentLogo
            backend={backend.name}
            className={cn("size-5 shrink-0", !on && "opacity-40 grayscale")}
          />
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              {label}
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

        <div className="flex shrink-0 items-center gap-2">
          {/* Which one a message's ⋯ menu offers. A chip on the row that has it — exactly
              one provider does, so there is nothing to switch off — and a button on a row
              that could take it. A provider that would never answer is offered neither:
              the menu falls back to what does answer (`defaultUsableBackends`), so making
              that one the default would decide nothing. */}
          {props.isDefault ? (
            <span
              data-testid="ai-provider-default"
              data-state="on"
              className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-1 text-[11px] font-semibold text-primary"
            >
              <HugeiconsIcon icon={CheckIcon} className="size-3" strokeWidth={2.5} /> Default
            </span>
          ) : (
            on && (
              <button
                type="button"
                data-testid="ai-provider-default"
                data-state="off"
                disabled={busy}
                onClick={() => void save({ default: true })}
                title={`Offer ${label} in a message's ⋯ menu`}
                className={cn(
                  "cursor-pointer rounded-full bg-element px-2 py-1 text-[11px] font-medium text-text-dim transition-colors hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  busy && "opacity-60",
                )}
              >
                Set as default
              </button>
            )
          )}

          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`Enable the ${label} provider`}
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
      </div>

      {/* No CLI, no model to choose: a control that could never change a run is a
          question with no answer. */}
      {backend.available && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-text-faint">Model</span>
          <AgentModelSelect
            backend={backend}
            busy={busy}
            onChoose={(model) => void save({ model })}
          />
        </div>
      )}

      {error && (
        <span data-testid="ai-provider-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
